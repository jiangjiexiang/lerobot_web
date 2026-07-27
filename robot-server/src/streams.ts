import { Request, Response } from "express";

/**
 * MJPEGStreamManager - 管理 MJPEG 视频流
 * 缓存最新帧，支持多个客户端连接
 */
export class MJPEGStreamManager {
  private latestFrames: Map<string, Buffer> = new Map();
  private boundaries: Map<string, string> = new Map();

  constructor() {
    // 为每个流设置 boundary 标识
    this.boundaries.set("camera", "boundary_camera");
    this.boundaries.set("camera2", "boundary_camera2");
    this.boundaries.set("mujoco", "boundary_mujoco");
  }

  /**
   * 更新指定流的最新帧
   * @param streamName 流名称 ("camera" | "camera2" | "mujoco")
   * @param jpegBuffer JPEG 图片的 Buffer
   */
  updateFrame(streamName: string, jpegBuffer: Buffer): void {
    this.latestFrames.set(streamName, jpegBuffer);
  }

  /**
   * 处理 MJPEG HTTP 请求，持续推送帧
   */
  handleStream(streamName: string, req: Request, res: Response): void {
    const boundary = this.boundaries.get(streamName);
    if (!boundary) {
      res.status(404).send(`Stream '${streamName}' not found`);
      return;
    }

    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-cache",
      Connection: "close",
    });

    // 定期发送最新帧
    const interval = setInterval(() => {
      const frame = this.latestFrames.get(streamName);
      if (frame) {
        const header = [
          `--${boundary}`,
          "Content-Type: image/jpeg",
          `Content-Length: ${frame.length}`,
          "",
          "",
        ].join("\r\n");

        try {
          res.write(header);
          res.write(frame);
          res.write("\r\n");
        } catch {
          clearInterval(interval);
        }
      }
    }, 33); // ~30fps

    req.on("close", () => {
      clearInterval(interval);
    });
  }
}
