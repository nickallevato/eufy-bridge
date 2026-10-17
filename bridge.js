// Eufy doorbell -> continuous RTSP for an NVR.
//
// The doorbell runs on a battery, so it streams only on events. The NVR still
// sees one unbroken H.264 stream at fixed geometry:
//   idle: a pre-encoded 5 s loop of the last live frame (dimmed, blurred,
//         labelled), replayed access unit by access unit -- encoded once per
//         event, ~0 CPU to replay, ~28 kbps on the wire
//   live: the P2P livestream, re-encoded with the same SPS as the loop so the
//         switch is invisible to the decoder
// Both sources are cut on access-unit boundaries (AUD NALs), every switch lands
// on an IDR, and one 10 fps clock paces both, so the muxer only ever does
// -c copy and the output timestamps are constant-rate.
//
// Triggers: motion/person/ring/... events from Eufy's cloud push, or
//   GET http://<host>:8099/live?s=60   manual "go live"
//   GET http://<host>:8099/status
//
// Env: EUFY_USER, EUFY_PASS (required), EUFY_COUNTRY (US), EUFY_DEVICE_SN,
//      RTSP_URL (rtsp://127.0.0.1:8554/doorbell), LIVE_SECONDS (45),
//      CONTROL_PORT (8099), STATE_DIR (~/.local/state/eufy-bridge),
//      EUFY_TRUSTED_DEVICE (eufy-bridge: the name Eufy shows for this login)
// First login may ask for an emailed code: write it to $STATE_DIR/tfa-code.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");
const { EufySecurity, P2PConnectionType, VideoCodec } = require("eufy-security-client");

const STATE = process.env.STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "eufy-bridge");
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
const RTSP_URL = process.env.RTSP_URL || "rtsp://127.0.0.1:8554/doorbell";
const LIVE_SECONDS = Number(process.env.LIVE_SECONDS || 45);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8099);
const W = 800, H = 1100, FPS = 10;
// Live: keyframe every 2 s, normal quality. Idle: one 5 s GOP of a blurred, dimmed
// still at low quality -- ~28 kbps (~300 MB/day) instead of ~280 kbps (~3 GB/day).
// A reader joining during idle waits at most IDLE_GOP frames for a picture.
const LIVE_GOP = 20, LIVE_CRF = 23, IDLE_GOP = 50, IDLE_CRF = 32, IDLE_BLUR = 4;
const LIVE_PREBUFFER = 5; // AUs queued before cutting over, absorbs encoder bursts
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const LAST_JPG = path.join(STATE, "last.jpg");
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Same SPS for the idle loop and the live re-encode (geometry, profile, level, no
// B-frames). GOP and CRF differ, which only changes slice data and the PPS, and
// the PPS is repeated with every IDR. Threads and lookahead are not in the SPS, so
// the live encoder can drop them for latency (`-tune zerolatency` would change it).
const x264 = (gop, crf, extra = []) => [
  "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-level", "4.0",
  "-pix_fmt", "yuv420p", "-bf", "0", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0",
  "-crf", String(crf), ...extra,
  "-bsf:v", "h264_metadata=aud=insert", "-f", "h264",
];
const IDLE_X264 = ["-x264-params", "repeat-headers=1"];
// Default threading + lookahead held ~3 s of frames before the first output.
const LIVE_X264 = ["-threads", "2", "-x264-params", "repeat-headers=1:rc-lookahead=0:sync-lookahead=0"];
const SCALE = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

// ---- Annex B access-unit splitter (splits on AUD, NAL type 9) ----
class AUSplitter {
  constructor(onAU) { this.buf = Buffer.alloc(0); this.onAU = onAU; }
  static audOffsets(b) {
    const out = [];
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 9) {
        out.push(i > 0 && b[i - 1] === 0 ? i - 1 : i);
        i += 3;
      }
    }
    return out;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const offs = AUSplitter.audOffsets(this.buf);
    if (offs.length < 2) return;
    for (let k = 0; k < offs.length - 1; k++) this.onAU(this.buf.subarray(offs[k], offs[k + 1]));
    this.buf = Buffer.from(this.buf.subarray(offs[offs.length - 1]));
  }
  flush() { if (this.buf.length) this.onAU(this.buf); this.buf = Buffer.alloc(0); }
}
const isIDR = (au) => {
  for (let i = 0; i + 3 < au.length; i++)
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 5) return true;
  return false;
};

// ---- state ----
let eufy, doorbellSN;
let mode = "idle";            // "idle" | "live"
let idleAUs = [], idleIdx = 0;
let muxer = null;
let liveQueue = [], liveGen = 0;
let liveEnc = null, liveUntil = 0, streaming = false, startingLive = false;
// last.jpg is rewritten during every live session, so its mtime survives restarts
const stats = {
  underflows: 0, liveSessions: 0, lastEvent: null, auIdle: 0, auLive: 0,
  lastLive: fs.existsSync(LAST_JPG) ? fs.statSync(LAST_JPG).mtimeMs : null,
};

function writeAU(au) {
  if (!muxer || !muxer.stdin.writable) return;
  muxer.stdin.write(au);
}

// ---- muxer: raw H.264 in, RTSP out, copy only ----
function startMuxer() {
  muxer = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "+genpts", "-f", "h264", "-framerate", String(FPS), "-i", "pipe:0",
    "-c", "copy", "-f", "rtsp", "-rtsp_transport", "tcp", RTSP_URL,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  muxer.stdin.on("error", () => {});
  muxer.on("exit", (code) => {
    log(`muxer exited ${code}; restarting`);
    muxer = null;
    setTimeout(() => { idleIdx = 0; mode = "idle"; startMuxer(); }, 2000);
  });
  idleIdx = 0;
}

// ---- idle loop: encode once from the last live frame ----
function buildIdleLoop() {
  return new Promise((resolve) => {
    const label = path.join(STATE, "label.txt");
    const when = stats.lastLive ? new Date(stats.lastLive).toLocaleTimeString("en-US", { hour12: false }) : "never";
    fs.writeFileSync(label, `doorbell idle - last live ${when}`);
    const input = fs.existsSync(LAST_JPG)
      ? ["-loop", "1", "-framerate", String(FPS), "-i", LAST_JPG]
      : ["-f", "lavfi", "-i", `color=c=0x202020:s=${W}x${H}:r=${FPS}`];
    const vf = `${SCALE},eq=brightness=-0.12:saturation=0.4,gblur=sigma=${IDLE_BLUR},` +
      `drawtext=fontfile=${FONT}:textfile=${label}:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=12:y=h-th-20`;
    const out = path.join(STATE, "idle-loop.h264");
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...input,
      "-t", String(IDLE_GOP / FPS), "-vf", vf, ...x264(IDLE_GOP, IDLE_CRF, IDLE_X264), out], (err) => {
      if (err) { log("idle loop encode failed:", err.message); return resolve(); }
      const aus = [];
      const sp = new AUSplitter((au) => aus.push(Buffer.from(au)));
      sp.push(fs.readFileSync(out)); sp.flush();
      if (!aus.length || !isIDR(aus[0])) { log("idle loop malformed; keeping the old one"); return resolve(); }
      idleAUs = aus;
      if (mode === "idle") idleIdx = 0; // restart on the new loop's IDR
      log(`idle loop ready: ${aus.length} AUs, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
      resolve();
    });
  });
}

// One clock for both sources: exactly one AU per tick, so timestamps are CFR.
setInterval(() => {
  if (mode === "live") {
    if (!liveQueue.length) { stats.underflows++; return; }
    writeAU(liveQueue.shift()); stats.auLive++;
    return;
  }
  if (!idleAUs.length) return;
  if (idleIdx >= idleAUs.length) idleIdx = 0;
  writeAU(idleAUs[idleIdx++]);
  stats.auIdle++;
}, 1000 / FPS);

// ---- live ----
function triggerLive(reason, seconds = LIVE_SECONDS) {
  const busy = streaming || startingLive;
  stats.lastEvent = { reason, at: new Date().toISOString() };
  liveUntil = Math.max(liveUntil, Date.now() + seconds * 1000);
  // a watching viewer re-fires on every HLS poll; only log the one that wakes it
  if (!busy || reason !== "viewer") log(`trigger: ${reason} -> live until ${new Date(liveUntil).toISOString()}`);
  if (busy || !doorbellSN) return;
  // stays set until the stream actually arrives: the call resolves seconds before
  // the "livestream start" event, and a trigger in that gap would start it twice
  startingLive = true;
  const giveUp = setTimeout(() => { startingLive = false; }, 20000);
  eufy.startStationLivestream(doorbellSN)
    .catch((e) => { log("startStationLivestream failed:", e.message); clearTimeout(giveUp); startingLive = false; });
}

function startLiveEncoder(metadata, video, audio) {
  const vfmt = metadata.videoCodec === VideoCodec.H265 ? "hevc" : "h264";
  log(`livestream: ${vfmt} ${metadata.videoWidth}x${metadata.videoHeight}`);
  streaming = true;
  startingLive = false;
  stats.liveSessions++;
  liveEnc = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    // no stream probing: the probe alone held the first frame for ~1 s
    "-fflags", "+genpts", "-probesize", "32", "-analyzeduration", "0", "-flags", "low_delay",
    "-use_wallclock_as_timestamps", "1", "-f", vfmt, "-i", "pipe:0",
    "-map", "0:v", "-vf", SCALE, ...x264(LIVE_GOP, LIVE_CRF, LIVE_X264), "pipe:1",
    "-map", "0:v", "-vf", `fps=1,scale=${W}:-2`, "-f", "image2", "-update", "1", "-y", LAST_JPG,
  ], { stdio: ["pipe", "pipe", "inherit"] });
  liveEnc.stdin.on("error", () => {});
  const gen = ++liveGen;
  liveQueue = [];
  const sp = new AUSplitter((au) => {
    if (gen !== liveGen || !streaming) return;      // a finished session's tail
    if (mode === "idle") {
      if (!liveQueue.length && !isIDR(au)) return;  // queue must start on an IDR
      liveQueue.push(Buffer.from(au));
      if (liveQueue.length >= LIVE_PREBUFFER) { mode = "live"; log("output: idle -> live"); }
      return;
    }
    liveQueue.push(Buffer.from(au));
  });
  liveEnc.stdout.on("data", (c) => sp.push(c));
  liveEnc.on("exit", () => { liveEnc = null; });
  video.pipe(liveEnc.stdin);
  audio.resume(); // video only; drain audio so the P2P session doesn't stall
}

function endLive(why) {
  if (mode === "live") log(`output: live -> idle (${why})`);
  mode = "idle";
  idleIdx = 0;
  streaming = false;
  liveGen++;
  liveQueue = [];
  if (liveEnc) { try { liveEnc.stdin.end(); } catch {} setTimeout(() => liveEnc && liveEnc.kill("SIGTERM"), 3000); }
  stats.lastLive = Date.now();
  setTimeout(buildIdleLoop, 1500); // after the encoder has written its final last.jpg
}

setInterval(() => {
  if (streaming && Date.now() > liveUntil && doorbellSN) {
    log("live window over; stopping livestream");
    eufy.stopStationLivestream(doorbellSN).catch((e) => log("stop failed:", e.message));
    endLive("window over");
  }
}, 1000);

// ---- control API ----
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/live") {
    const s = Math.min(Math.max(Number(u.searchParams.get("s")) || 60, 5), 600);
    const reason = /^[a-z-]{1,20}$/.test(u.searchParams.get("reason") || "") ? u.searchParams.get("reason") : "manual";
    triggerLive(reason, s);
    res.writeHead(200, { "content-type": "text/plain" }); return res.end(`live for ${s}s\n`);
  }
  if (u.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      mode, streaming, doorbell: doorbellSN || null,
      liveUntil: liveUntil ? new Date(liveUntil).toISOString() : null, idleAUs: idleAUs.length, ...stats,
    }, null, 2) + "\n");
  }
  res.writeHead(404); res.end();
}).listen(CONTROL_PORT, () => log(`control API on :${CONTROL_PORT} (/live?s=60[&reason=viewer], /status)`));

// ---- eufy ----
function waitForFile(name) {
  const f = path.join(STATE, name);
  try { fs.unlinkSync(f); } catch {}
  log(`waiting for ${f}`);
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!fs.existsSync(f)) return;
      const v = fs.readFileSync(f, "utf8").trim();
      if (!v) return;
      clearInterval(t);
      fs.unlinkSync(f);
      resolve(v);
    }, 1000);
  });
}

async function main() {
  const { EUFY_USER, EUFY_PASS } = process.env;
  if (!EUFY_USER || !EUFY_PASS) { console.error("set EUFY_USER and EUFY_PASS"); process.exit(1); }

  await buildIdleLoop();
  startMuxer();

  eufy = await EufySecurity.initialize({
    username: EUFY_USER, password: EUFY_PASS,
    country: process.env.EUFY_COUNTRY || "US", language: "en",
    // Changing this name makes Eufy treat the bridge as a new device (new 2FA).
    trustedDeviceName: process.env.EUFY_TRUSTED_DEVICE || "eufy-bridge", persistentDir: STATE,
    p2pConnectionSetup: P2PConnectionType.QUICKEST,
    pollingIntervalMinutes: 10, eventDurationSeconds: 10,
    acceptInvitations: true, // accept the main account's share on its own
  });
  eufy.setCameraMaxLivestreamDuration(0); // the library caps livestreams at 30 s by default

  const pick = (d) => process.env.EUFY_DEVICE_SN ? d.getSerial() === process.env.EUFY_DEVICE_SN : d.isDoorbell();
  eufy.on("device added", (d) => {
    if (!doorbellSN && pick(d)) { doorbellSN = d.getSerial(); log(`doorbell: ${d.getName()} ${doorbellSN}`); }
  });
  eufy.on("connect", () => log("logged in to Eufy cloud"));
  eufy.on("push connect", () => log("push notifications connected (event triggers armed)"));
  eufy.on("push close", () => log("push notifications closed"));
  eufy.on("connection error", (e) => log("connection error:", e.message));
  eufy.on("tfa request", async () => {
    log("Eufy emailed a login code");
    await eufy.connect({ verifyCode: await waitForFile("tfa-code"), force: false });
  });
  eufy.on("captcha request", async (id, captcha) => {
    fs.writeFileSync(path.join(STATE, "captcha.png"), Buffer.from(captcha.split(",").pop(), "base64"));
    log(`captcha required: see ${path.join(STATE, "captcha.png")}`);
    await eufy.connect({ captcha: { captchaId: id, captchaCode: await waitForFile("captcha-code") }, force: false });
  });

  const evt = (name) => eufy.on(name, (d, state) => {
    if (d.getSerial() !== doorbellSN || !state) return;
    triggerLive(name.replace("device ", ""));
  });
  ["device motion detected", "device person detected", "device rings", "device stranger person detected",
    "device package delivered", "device vehicle detected", "device pet detected", "device radar motion detected"].forEach(evt);

  eufy.on("station livestream start", (_s, d, metadata, video, audio) => {
    if (d.getSerial() !== doorbellSN) return;
    startLiveEncoder(metadata, video, audio);
  });
  eufy.on("station livestream stop", (_s, d) => {
    if (d.getSerial() !== doorbellSN) return;
    if (streaming) endLive("doorbell stopped the stream");
  });

  await eufy.connect();
}

const shutdown = async () => {
  log("shutting down");
  try { if (streaming && doorbellSN) await eufy.stopStationLivestream(doorbellSN); eufy.close(); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => { console.error(e); process.exit(1); });
