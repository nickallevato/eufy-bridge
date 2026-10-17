#!/usr/bin/env python3
"""Manage the Shinobi 'doorbell' monitor fed by the eufy bridge.

Runs ON the Shinobi host as root, for example via Ansible:

  ansible shinobi -b -m ansible.builtin.script \\
      -a "shinobi/doorbell_monitor.py --group <group> [--template <mid>] <command> [args]"

  --group      Shinobi group key (required)
  --template   monitor to clone on `apply`: a plain RTSP record-mode monitor

It reads the admin account's API key from the ccio DB and talks to Shinobi on
localhost, so the key never leaves the host and is never printed.

  apply <rtsp_url>   create or update the monitor (cloned from --template) and turn
                     its JPEG API on
  check              status, newest recordings, one snapshot -> /tmp/doorbell-snap.jpg
  grab [out.jpg]     one frame from Shinobi's own HLS output -> /tmp/doorbell-hls.jpg
  inspect            the template's source settings, credentials redacted
  remove             delete the monitor (recordings stay on disk)

Two Shinobi traps this works around:
  - configureMonitor stores details.snap "1" as the number 1, but the JPEG API is
    only built when snap === '1'. So `apply` sets it in the DB afterwards and
    cycles the monitor stop -> record, which reloads the row from the DB.
  - The read-only agent keys cache their camera list until `pm2 restart camera`;
    a new monitor is invisible to them until then.
"""
import json, re, subprocess, sys, urllib.parse, urllib.request

GROUP = None          # --group
TEMPLATE_MID = None   # --template: a plain RTSP record-mode monitor, codecs "copy"
MID = "doorbell"
NAME = "doorbell"
BASE = "http://127.0.0.1:8080"
SECRET_KEYS = re.compile(r"pass|user|token|key|secret", re.I)


def sql(q):
    return subprocess.run(["mysql", "-N", "-B", "ccio", "-e", q], check=True,
                          capture_output=True, text=True).stdout.strip()


def admin_key():
    rows = sql(f"SELECT a.code, a.details FROM API a JOIN Users u ON a.uid=u.uid AND a.ke=u.ke "
               f"WHERE a.ke='{GROUP}' AND u.details NOT LIKE '%\"sub\"%'").splitlines()
    for r in rows:
        code, details = r.split("\t", 1)
        try:
            perms = json.loads(details)
        except ValueError:
            perms = {}
        if perms.get("edit_monitors", "1") != "0":
            return code
    sys.exit("no admin API key with edit_monitors on the group")


def call(key, route, data=None):
    body = urllib.parse.urlencode({"data": json.dumps(data)}).encode() if data is not None else None
    with urllib.request.urlopen(urllib.request.Request(f"{BASE}/{key}/{route}", data=body), timeout=20) as r:
        return json.loads(r.read())


def monitor(key, mid):
    m = call(key, f"monitor/{GROUP}/{mid}")
    m = m[0] if isinstance(m, list) else m
    if isinstance(m.get("details"), str):
        m["details"] = json.loads(m["details"])
    return m


def ok_msg(r):
    return json.dumps({k: r.get(k) for k in ("ok", "msg")})


def redact(v, k=""):
    if SECRET_KEYS.search(k) and v:
        return "***"
    return re.sub(r"//[^@/]*@", "//***@", v) if isinstance(v, str) else v


def apply(key, url):
    tmpl = monitor(key, TEMPLATE_MID)
    u = urllib.parse.urlparse(url)
    det = dict(tmpl["details"])
    det.update({"auto_host": url, "auto_host_enable": "1", "muser": "", "mpass": "",
                "rtsp_transport": "tcp", "snap": "1"})   # codecs stay "copy", as on the template
    mon = {
        "mid": MID, "ke": GROUP, "name": NAME,
        "type": "h264", "protocol": "rtsp", "host": u.hostname, "port": str(u.port or 554),
        "path": u.path, "mode": "record", "ext": tmpl.get("ext", "mp4"),
        "fps": "10", "width": "800", "height": "1100",
        "details": det,
    }
    print("configure", ok_msg(call(key, f"configureMonitor/{GROUP}/{MID}", mon)))
    sql(f"UPDATE Monitors SET details=JSON_SET(details,'$.snap','1') WHERE ke='{GROUP}' AND mid='{MID}'")
    for f in ("stop", "record"):
        print(f, ok_msg(call(key, f"monitor/{GROUP}/{MID}/{f}")))


def parse_args(argv):
    global GROUP, TEMPLATE_MID
    rest = []
    it = iter(argv)
    for a in it:
        if a == "--group":
            GROUP = next(it, None)
        elif a == "--template":
            TEMPLATE_MID = next(it, None)
        else:
            rest.append(a)
    if not GROUP or not re.fullmatch(r"[A-Za-z0-9_-]+", GROUP):
        sys.exit(__doc__)
    if TEMPLATE_MID and not re.fullmatch(r"[A-Za-z0-9_-]+", TEMPLATE_MID):
        sys.exit("bad --template")
    return rest


def main():
    argv = parse_args(sys.argv[1:])
    cmd = argv[0] if argv else ""
    if cmd in ("apply", "inspect") and not TEMPLATE_MID:
        sys.exit(f"{cmd} needs --template <monitor-id>")
    key = admin_key()

    if cmd == "apply" and len(argv) > 1:
        apply(key, argv[1])
    elif cmd == "check":
        m = monitor(key, MID)
        print(json.dumps({"mid": m.get("mid"), "status": m.get("status"), "mode": m.get("mode"),
                          "snap": m["details"].get("snap")}))
        v = call(key, f"videos/{GROUP}/{MID}?limit=5")
        print(json.dumps([{k: x.get(k) for k in ("time", "end", "size")} for x in v.get("videos", [])]))
        with urllib.request.urlopen(f"{BASE}/{key}/jpeg/{GROUP}/{MID}/s.jpg", timeout=20) as r, \
                open("/tmp/doorbell-snap.jpg", "wb") as f:
            f.write(r.read())
        print("snapshot: /tmp/doorbell-snap.jpg")
    elif cmd == "grab":
        out = argv[1] if len(argv) > 1 else "/tmp/doorbell-hls.jpg"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"{BASE}/{key}/hls/{GROUP}/{MID}/s.m3u8",
                        "-frames:v", "1", out], check=True, timeout=60)
        print("hls frame:", out)
    elif cmd == "inspect":
        m = monitor(key, TEMPLATE_MID)
        print(json.dumps({k: redact(m.get(k), k) for k in
                          ("mid", "name", "type", "protocol", "host", "port", "path", "mode", "fps", "width", "height", "ext")}))
        print(json.dumps({k: redact(v, k) for k, v in m["details"].items()}, indent=1, sort_keys=True))
    elif cmd == "remove":
        print(ok_msg(call(key, f"configureMonitor/{GROUP}/{MID}/delete")))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
