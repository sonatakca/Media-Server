import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import {
  DEFAULT_SEO_DESCRIPTION,
  DEFAULT_SEO_TITLE,
  setSeoMetadata,
} from "../lib/seo";

export function PublicLandingPage() {
  useEffect(() => {
    setSeoMetadata({
      title: DEFAULT_SEO_TITLE,
      description: DEFAULT_SEO_DESCRIPTION,
      canonicalPath: "/",
      robots: "noindex, nofollow",
    });
  }, []);

  return <Navigate to="/home" replace />;
}
