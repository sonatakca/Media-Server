export interface LibraryPageProps {
  mode?: "library" | "series" | "season";
  libraryId?: string;
  canonicalPath?: string;
  libraryRouteKind?: "movie" | "show" | "collection";
}
