import { lazy, Suspense } from "react";

const BookReaderPage = lazy(() =>
  import("./BookReaderPage").then((module) => ({
    default: module.BookReaderPage,
  })),
);

function ReaderPageLoading() {
  return <main className="min-h-screen bg-black" />;
}

export function ReaderPage() {
  return (
    <Suspense fallback={<ReaderPageLoading />}>
      <BookReaderPage />
    </Suspense>
  );
}
