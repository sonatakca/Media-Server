const DEVICE_ID_KEY = "seyirlik.deviceId";

function createDeviceId(): string {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);

  if (existing) {
    return existing;
  }

  const deviceId = createDeviceId();
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export function getDeviceName(): string {
  return "Seyirlik Browser";
}

export interface ViewportCapabilities {
  width: number;
  height: number;
  isPortrait: boolean;
  isLandscape: boolean;
  hasCoarsePointer: boolean;
  isPhoneViewport: boolean;
}

export function readViewportCapabilities(): ViewportCapabilities {
  if (typeof window === "undefined") {
    return {
      width: 1024,
      height: 768,
      isPortrait: false,
      isLandscape: true,
      hasCoarsePointer: false,
      isPhoneViewport: false,
    };
  }

  const width = Math.round(window.visualViewport?.width ?? window.innerWidth);
  const height = Math.round(
    window.visualViewport?.height ?? window.innerHeight,
  );
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const isPortrait = height >= width;
  const hasCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

  return {
    width,
    height,
    isPortrait,
    isLandscape: !isPortrait,
    hasCoarsePointer,
    isPhoneViewport: hasCoarsePointer && shortSide <= 520 && longSide <= 980,
  };
}
