const assert = require("assert");
const { RTCPeerConnection } = require("@roamhq/wrtc");
const { RtcGateway } = require("../dist/rtcGateway");

function waitForChannel(channel, timeoutMs = 5000) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${channel.label} open timeout`)), timeoutMs);
    channel.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function nextMessage(channel, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${channel.label} message timeout`)), timeoutMs);
    channel.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
  });
}

function waitForIceGathering(peer, timeoutMs = 5000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const listener = () => {
      if (peer.iceGatheringState === "complete") {
        clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", listener);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", listener);
  });
}

async function main() {
  let receivedControl;
  let controlCount = 0;
  let safetyStops = 0;
  let resolveControl;
  const controlReceived = new Promise((resolve) => { resolveControl = resolve; });
  const gateway = new RtcGateway({
    enabled: true,
    onControl: (message) => { receivedControl = message; controlCount += 1; resolveControl(); },
    onSafetyStop: () => { safetyStops += 1; },
    onControlLost: () => undefined,
  });
  const client = new RTCPeerConnection();
  const control = client.createDataChannel("robot-control-v1", { ordered: false, maxRetransmits: 0 });
  const state = client.createDataChannel("robot-state-v1", { ordered: true });
  const video = client.createDataChannel("robot-video-v1", { ordered: false, maxRetransmits: 0 });
  const safety = client.createDataChannel("robot-safety-v1", { ordered: true });

  try {
    const offer = await client.createOffer();
    await client.setLocalDescription(offer);
    await waitForIceGathering(client);
    const answer = await gateway.acceptOffer(client.localDescription);
    await client.setRemoteDescription(answer);
    await Promise.all([control, state, video, safety].map((channel) => waitForChannel(channel)));

    control.send(JSON.stringify({ type: "action", seq: 1, joints: { joint_a: 0.5 } }));
    await Promise.race([
      controlReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error("control timeout")), 5000)),
    ]);
    assert.deepStrictEqual(receivedControl.joints, { joint_a: 0.5 });
    control.send(JSON.stringify({ type: "action", seq: 1, joints: { joint_a: 0.9 } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(controlCount, 1, "duplicate sequence must be ignored");

    const stateMessage = nextMessage(state);
    gateway.broadcastControl({ type: "teleop_observation", follower: { joint_a: 0.25 } });
    assert.deepStrictEqual(
      JSON.parse(String(await stateMessage)).follower,
      { joint_a: 0.25 },
    );

    const videoMessage = nextMessage(video);
    gateway.broadcastFrame(Buffer.from([1, 2, 3, 4]));
    assert.deepStrictEqual(Buffer.from(await videoMessage), Buffer.from([1, 2, 3, 4]));
    safety.send(JSON.stringify({ type: "stop" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(safetyStops, 1);
    console.log("WebRTC control/state/video DataChannel integration: OK");
  } finally {
    client.close();
    await gateway.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
