const assert = require("assert");
const { JpegStreamParser } = require("../dist/gstreamerCameraBridge");

const parser = new JpegStreamParser();
const frame1 = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const frame2 = Buffer.from([0xff, 0xd8, 4, 5, 0xff, 0xd9]);

assert.deepStrictEqual(parser.push(Buffer.from([9, 9, ...frame1.subarray(0, 4)])), []);
assert.deepStrictEqual(parser.push(Buffer.concat([frame1.subarray(4), frame2.subarray(0, 3)])), [frame1]);
assert.deepStrictEqual(parser.push(frame2.subarray(3)), [frame2]);
console.log("GStreamer MJPEG stream parser: OK");
