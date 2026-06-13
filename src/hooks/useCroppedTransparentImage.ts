import { useEffect, useState } from "react";
import { cropTransparentImage } from "../lib/cropTransparentImage";

export function useCroppedTransparentImage(
  sourceUrl: string | null | undefined,
): string {
  const normalizedSourceUrl = sourceUrl ?? "";
  const [processedUrl, setProcessedUrl] = useState<string>(normalizedSourceUrl);

  useEffect(() => {
    let cancelled = false;

    setProcessedUrl(normalizedSourceUrl);

    if (!normalizedSourceUrl) {
      return;
    }

    void cropTransparentImage(normalizedSourceUrl, {
      alphaThreshold: 0,
      padding: 20,
    }).then((croppedUrl) => {
      if (!cancelled) {
        setProcessedUrl(croppedUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [normalizedSourceUrl]);

  return processedUrl;
}
