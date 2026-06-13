interface CropTransparentImageOptions {
  alphaThreshold?: number;
  padding?: number;
}

const croppedLogoCache = new Map<string, Promise<string>>();

export function cropTransparentImage(
  sourceUrl: string,
  options: CropTransparentImageOptions = {},
): Promise<string> {
  const alphaThreshold = options.alphaThreshold ?? 8;
  const padding = options.padding ?? 2;
  const cacheKey = `${sourceUrl}:${alphaThreshold}:${padding}`;

  const cached = croppedLogoCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const cropPromise = performTransparentCrop(sourceUrl, {
    alphaThreshold,
    padding,
  }).catch((error) => {
    console.warn("[Seyirlik Logo] Transparent crop failed", {
      sourceUrl,
      error,
    });

    return sourceUrl;
  });

  croppedLogoCache.set(cacheKey, cropPromise);

  return cropPromise;
}

async function performTransparentCrop(
  sourceUrl: string,
  { alphaThreshold = 8, padding = 2 }: CropTransparentImageOptions,
): Promise<string> {
  const response = await fetch(sourceUrl, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Logo request failed with status ${response.status}`);
  }

  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      return sourceUrl;
    }

    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = bitmap.width;
    sourceCanvas.height = bitmap.height;

    const sourceContext = sourceCanvas.getContext("2d", {
      willReadFrequently: true,
    });

    if (!sourceContext) {
      throw new Error("Could not create source canvas context");
    }

    sourceContext.clearRect(0, 0, bitmap.width, bitmap.height);
    sourceContext.drawImage(bitmap, 0, 0);

    const imageData = sourceContext.getImageData(
      0,
      0,
      bitmap.width,
      bitmap.height,
    );

    const pixels = imageData.data;

    let left = bitmap.width;
    let right = -1;
    let top = bitmap.height;
    let bottom = -1;

    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        const alphaIndex = (y * bitmap.width + x) * 4 + 3;
        const alpha = pixels[alphaIndex];

        if (alpha <= alphaThreshold) {
          continue;
        }

        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }

    // The whole image is transparent.
    if (right < left || bottom < top) {
      return sourceUrl;
    }

    left = Math.max(0, left - padding);
    right = Math.min(bitmap.width - 1, right + padding);
    top = Math.max(0, top - padding);
    bottom = Math.min(bitmap.height - 1, bottom + padding);

    const croppedWidth = right - left + 1;
    const croppedHeight = bottom - top + 1;

    if (croppedWidth === bitmap.width && croppedHeight === bitmap.height) {
      return sourceUrl;
    }

    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.width = croppedWidth;
    croppedCanvas.height = croppedHeight;

    const croppedContext = croppedCanvas.getContext("2d");

    if (!croppedContext) {
      throw new Error("Could not create cropped canvas context");
    }

    croppedContext.clearRect(0, 0, croppedWidth, croppedHeight);

    croppedContext.drawImage(
      bitmap,
      left,
      top,
      croppedWidth,
      croppedHeight,
      0,
      0,
      croppedWidth,
      croppedHeight,
    );

    const croppedBlob = await canvasToBlob(croppedCanvas);

    return URL.createObjectURL(croppedBlob);
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not create cropped logo blob"));
        return;
      }

      resolve(blob);
    }, "image/png");
  });
}
