import { Navbar } from "./Navbar";
import { RouteTransitionOutlet } from "./RouteTransitionOutlet";

export function Layout() {
  return (
    <div className="min-h-screen bg-transparent text-white">
      <Navbar />
      <main className="mx-auto w-full max-w-[1600px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
        <RouteTransitionOutlet />
      </main>
    </div>
  );
}
