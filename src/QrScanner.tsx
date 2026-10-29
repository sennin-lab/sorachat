import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// カメラ映像からQRコードを読み取る（BarcodeDetector非対応のiPhoneでも動く）
export function QrScanner({ onDetect }: { onDetect: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const detectRef = useRef(onDetect);
  detectRef.current = onDetect;
  const [status, setStatus] = useState<"starting" | "scanning" | "denied">("starting");

  useEffect(() => {
    let active = true;
    let frame = 0;
    let stream: MediaStream | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      const video = videoRef.current;
      if (!active || !video || !ctx) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const width = Math.min(video.videoWidth, 640);
        canvas.width = width;
        canvas.height = Math.round((video.videoHeight * width) / video.videoWidth);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          active = false;
          detectRef.current(code.data);
          return;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        });
        if (!active || !videoRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setStatus("scanning");
        frame = window.requestAnimationFrame(tick);
      } catch {
        if (active) setStatus("denied");
      }
    })();

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="scanner">
      <video ref={videoRef} muted playsInline />
      {status !== "scanning" && (
        <p className="scanner-note">
          {status === "starting" ? "カメラを起動しています…" : "カメラを使えません。カメラの許可を確認してください。"}
        </p>
      )}
    </div>
  );
}
