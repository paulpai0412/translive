export async function attachAudioToSink({ audio, sinkId, stream }) {
  if (!audio || typeof audio.setSinkId !== "function") {
    throw new Error("此 Electron 版本不支援指定音訊輸出裝置");
  }
  audio.autoplay = false;
  await audio.setSinkId(sinkId);
  audio.srcObject = stream;
  await audio.play();
}
