const assert = require("assert");
const { RTCPeerConnection, nonstandard } = require("@roamhq/wrtc");
const jpeg = require("jpeg-js");
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
    videoEnabled: true,
    onControl: (message) => { receivedControl = message; controlCount += 1; resolveControl(); },
    onSafetyStop: () => { safetyStops += 1; },
    onControlLost: () => undefined,
  });
  const client = new RTCPeerConnection();
  const control = client.createDataChannel("robot-control-v1", { ordered: false, maxRetransmits: 0 });
  const state = client.createDataChannel("robot-state-v1", { ordered: true });
  const safety = client.createDataChannel("robot-safety-v1", { ordered: true });
  client.addTransceiver("video", { direction: "recvonly" });
  client.addTransceiver("video", { direction: "recvonly" });
  const tracks = new Map();
  client.ontrack = (event) => tracks.set(event.transceiver.mid, event.track);

  try {
    const offer = await client.createOffer();
    await client.setLocalDescription(offer);
    await waitForIceGathering(client);
    const answer = await gateway.acceptOffer(client.localDescription);
    await client.setRemoteDescription(answer);
    await Promise.all([control, state, safety].map((channel) => waitForChannel(channel)));

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

    assert.ok(answer.videoMids.camera1 !== answer.videoMids.camera2);
    const camera1Track = tracks.get(answer.videoMids.camera1);
    const camera2Track = tracks.get(answer.videoMids.camera2);
    assert.ok(camera1Track, "camera1 RTP track must be negotiated");
    assert.ok(camera2Track, "camera2 RTP track must be negotiated");

    const sink = new nonstandard.RTCVideoSink(camera1Track);
    const sink2 = new nonstandard.RTCVideoSink(camera2Track);
    const receivedFrame = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("camera1 RTP video frame timeout")), 5000);
      sink.onframe = ({ frame }) => { clearTimeout(timer); resolve(frame); };
    });
    const receivedFrame2 = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("camera2 RTP video frame timeout")), 5000);
      sink2.onframe = ({ frame }) => { clearTimeout(timer); resolve(frame); };
    });
    const width = 4;
    const height = 4;
    const rgba = Buffer.alloc(width * height * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) {
      rgba[offset] = 40;
      rgba[offset + 1] = 120;
      rgba[offset + 2] = 220;
      rgba[offset + 3] = 255;
    }
    const jpegFrame = jpeg.encode({ data: rgba, width, height }, 80).data;
    const transportFrame = Buffer.alloc(9 + jpegFrame.length);
    transportFrame.writeUInt8(1, 0);
    jpegFrame.copy(transportFrame, 9);
    const transportFrame2 = Buffer.from(transportFrame);
    transportFrame2.writeUInt8(2, 0);
    const videoStartedAt = performance.now();
    gateway.broadcastFrame(transportFrame);
    gateway.broadcastFrame(transportFrame2);
    const [frame, frame2] = await Promise.all([receivedFrame, receivedFrame2]);
    const localVideoLatencyMs = performance.now() - videoStartedAt;
    assert.strictEqual(frame.width, width);
    assert.strictEqual(frame.height, height);
    assert.strictEqual(frame2.width, width);
    assert.strictEqual(frame2.height, height);
    assert.ok(localVideoLatencyMs < 1000, `dual-camera local RTP latency too high: ${localVideoLatencyMs.toFixed(1)}ms`);
    sink.stop();
    sink2.stop();
    safety.send(JSON.stringify({ type: "stop" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(safetyStops, 1);
    console.log(`WebRTC control/state/dual RTP video integration: OK (${localVideoLatencyMs.toFixed(1)}ms local pipeline)`);
  } finally {
    client.close();
    await gateway.close();
  }
  const hybridGateway = new RtcGateway({
    enabled: true,
    videoEnabled: false,
    onControl: () => undefined,
    onSafetyStop: () => undefined,
    onControlLost: () => undefined,
  });
  const hybridClient = new RTCPeerConnection();
  hybridClient.createDataChannel("robot-state-v1", { ordered: false, maxRetransmits: 0 });
  try {
    const offer = await hybridClient.createOffer();
    await hybridClient.setLocalDescription(offer);
    await waitForIceGathering(hybridClient);
    const answer = await hybridGateway.acceptOffer(hybridClient.localDescription);
    assert.deepStrictEqual(answer.videoMids, { camera1: "", camera2: "" });
    await hybridClient.setRemoteDescription(answer);
    assert.strictEqual(hybridGateway.isVideoEnabled(), false);
    console.log("WebRTC DataChannel + direct MJPEG hybrid mode: OK");
  } finally {
    hybridClient.close();
    await hybridGateway.close();
  }
  // @roamhq/wrtc keeps RTCVideoSource native handles alive after all peers close.
  // Explicit process termination avoids its teardown crash while preserving all
  // signaling, RTP frame and control assertions above.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
