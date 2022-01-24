import {
  MediaRecorder,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  Vp8RtpPayload,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { TransformStream } from "stream/web";
import { RTCEncodedFrame } from "werift/src/media/rtpReceiver";

// open ./answer.html

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const recorder = new MediaRecorder([], "./test.webm", {
    width: 640,
    height: 360,
  });

  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [],
        }),
      ],
    },
  });

  const transceiver = pc.addTransceiver("video");

  const { readable, writable } = transceiver.receiver.createEncodedStreams();
  let cache: Buffer | undefined = undefined;
  const transformStream = new TransformStream<RTCEncodedFrame, RTCEncodedFrame>(
    {
      transform: (frame, controller) => {
        const packet = Vp8RtpPayload.deSerialize(frame.data);
        if (!packet.isKeyframe && Math.random() < 0.05) {
          transceiver.receiver.sendRtcpPLI(frame.ssrc);
          frame.data = undefined;
        } else {
          cache = frame.data;
        }
        controller.enqueue(frame);
      },
    }
  );
  readable.pipeThrough(transformStream).pipeTo(writable);

  transceiver.onTrack.subscribe((track) => {
    transceiver.sender.replaceTrack(track);
    recorder.addTrack(track);
    recorder.start();
  });

  setTimeout(() => {
    recorder.stop();
    console.log("stop");
  }, 10_000);

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
