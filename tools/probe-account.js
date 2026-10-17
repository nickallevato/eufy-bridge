// Log in with the bridge's Eufy account and print what Eufy's cloud has for it:
// pending share invites, devices, and the doorbell's battery. Read-only.
//   node tools/probe-account.js        (needs EUFY_USER / EUFY_PASS, see bin/run-bridge)
"use strict";
const os = require("os");
const path = require("path");
const { EufySecurity, P2PConnectionType } = require("eufy-security-client");

const STATE = process.env.STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "eufy-bridge");

(async () => {
  const eufy = await EufySecurity.initialize({
    username: process.env.EUFY_USER, password: process.env.EUFY_PASS,
    country: process.env.EUFY_COUNTRY || "US", language: "en",
    trustedDeviceName: process.env.EUFY_TRUSTED_DEVICE || "eufy-bridge", persistentDir: STATE,
    p2pConnectionSetup: P2PConnectionType.QUICKEST, pollingIntervalMinutes: 0, eventDurationSeconds: 10,
    acceptInvitations: false,
  });
  eufy.on("tfa request", () => { console.log("Eufy wants a login code: run the bridge once to complete it"); process.exit(2); });
  eufy.on("connect", async () => {
    const api = eufy.api;
    console.log("device invites:", Object.keys(await api.getInvites().catch(() => ({}))).length);
    console.log("house invites: ", (await api.getHouseInviteList().catch(() => [])).length);
    for (const d of await eufy.getDevices()) {
      const p = d.getProperties();
      console.log(`device: ${d.getName()} sn=${d.getSerial()} model=${d.getModel()} type=${d.getDeviceType()}` +
        ` doorbell=${d.isDoorbell()}` + (p.battery !== undefined ? ` battery=${p.battery}% charging=${p.chargingStatus}` : ""));
    }
    eufy.close();
    process.exit(0);
  });
  await eufy.connect();
})().catch((e) => { console.error(e); process.exit(1); });
