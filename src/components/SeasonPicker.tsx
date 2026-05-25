import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";

export interface SeasonPickerOption {
  id: string;
  label: string;
}

interface SeasonPickerProps {
  activeSeasonId?: string;
  currentLabel: string;
  labelContent?: ReactNode;
  options: SeasonPickerOption[];
  selectLabel: string;
  variant?: "desktop" | "mobile";
}

export function SeasonPicker({
  activeSeasonId,
  currentLabel,
  labelContent,
  options,
  selectLabel,
  variant = "desktop",
}: SeasonPickerProps) {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const isDesktop = variant === "desktop";

  useEffect(() => {
    setIsOpen(false);
  }, [activeSeasonId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (seasonId: string) => {
    setIsOpen(false);

    if (seasonId !== activeSeasonId) {
      navigate(`/library/${seasonId}`);
    }
  };

  return (
    <div
      ref={rootRef}
      className={
        isDesktop
          ? "relative max-w-[44vw] sm:max-w-none"
          : "relative max-w-[44vw]"
      }
    >
      <button
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`${selectLabel}: ${currentLabel}`}
        onClick={() => setIsOpen((current) => !current)}
        className={[
          "group/season-label relative flex w-full items-center overflow-hidden border border-white/[0.12] bg-gray-700 shadow-soft-inset transition hover:border-white/[0.24] hover:bg-gray-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70",
          isDesktop
            ? "rounded-xl px-3 py-2 sm:rounded-2xl sm:px-5 sm:py-3"
            : "rounded-xl px-3 py-2",
        ].join(" ")}
      >
        <span className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,var(--accent-soft),transparent_58%)] opacity-70" />
        <span className="relative flex min-w-0 items-center gap-2">
          <span
            className={
              isDesktop
                ? "truncate text-xl font-black leading-none text-white sm:text-4xl"
                : "truncate text-sm font-black leading-none text-white"
            }
          >
            {labelContent ?? currentLabel}
          </span>
          <ChevronDown
            size={isDesktop ? 18 : 15}
            className={[
              "shrink-0 text-white/65 transition-transform",
              isOpen ? "rotate-180" : "",
            ].join(" ")}
          />
        </span>
      </button>

      {isOpen ? (
        <div
          role="menu"
          aria-label={selectLabel}
          className={[
            "absolute right-0 top-full z-[70] mt-2 max-h-64 min-w-full overflow-y-auto rounded-xl border border-white/[0.14] bg-[#17181c]/95 p-1.5 shadow-2xl backdrop-blur-xl",
            isDesktop ? "w-max min-w-[11rem]" : "w-max min-w-[9rem]",
          ].join(" ")}
        >
          {options.map((option) => {
            const isActive = option.id === activeSeasonId;

            return (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                aria-current={isActive ? "page" : undefined}
                onClick={() => handleSelect(option.id)}
                className={[
                  "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-bold transition hover:bg-white/[0.12] focus-visible:bg-white/[0.12] focus-visible:outline-none",
                  isActive ? "text-white" : "text-white/72",
                ].join(" ")}
              >
                <span>{option.label}</span>
                {isActive ? (
                  <Check className="shrink-0 text-[var(--accent)]" size={15} />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
