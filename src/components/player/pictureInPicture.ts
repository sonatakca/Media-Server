type WebKitPictureInPictureVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

/**
 * Whether this element can go into Picture in Picture from a tap.
 *
 * Safari answers through its own presentation-mode API, which is also the one
 * that works in a home-screen web app, where going home never starts Picture
 * in Picture by itself. Everything else uses the standard API.
 */
export function supportsPictureInPicture(video: HTMLVideoElement): boolean {
  const webkitVideo = video as WebKitPictureInPictureVideo;
  if (typeof webkitVideo.webkitSupportsPresentationMode === "function") {
    return webkitVideo.webkitSupportsPresentationMode("picture-in-picture");
  }
  return (
    document.pictureInPictureEnabled === true &&
    !video.disablePictureInPicture &&
    typeof video.requestPictureInPicture === "function"
  );
}

export function isInPictureInPicture(video: HTMLVideoElement): boolean {
  const webkitVideo = video as WebKitPictureInPictureVideo;
  return (
    webkitVideo.webkitPresentationMode === "picture-in-picture" ||
    document.pictureInPictureElement === video
  );
}

/** Must run inside the tap that asked for it; both browsers require a gesture. */
export function togglePictureInPicture(video: HTMLVideoElement): void {
  const webkitVideo = video as WebKitPictureInPictureVideo;
  const leaving = isInPictureInPicture(video);

  if (typeof webkitVideo.webkitSetPresentationMode === "function") {
    webkitVideo.webkitSetPresentationMode(
      leaving ? "inline" : "picture-in-picture",
    );
    return;
  }

  const request = leaving
    ? document.exitPictureInPicture()
    : video.requestPictureInPicture();
  request.catch((pictureInPictureError: unknown) => {
    console.warn(
      "[Seyirlik Playback] Picture in Picture was refused",
      pictureInPictureError,
    );
  });
}
