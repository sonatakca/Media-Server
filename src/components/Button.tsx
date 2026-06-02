import { Link, type LinkProps } from "react-router-dom";
import { Tooltip, type TooltipPlacement } from "./ui/Tooltip";

const baseClasses =
  "inline-flex min-h-10 transform-gpu items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100";

const variants = {
  primary: "bg-[var(--accent)] text-zinc-950 hover:bg-[var(--accent-hover)]",
  secondary:
    "border border-white/15 bg-white/10 text-white hover:bg-white/[0.16]",
  ghost: "text-zinc-200 hover:bg-white/10",
  danger:
    "border border-rose-300/30 bg-white/10 text-rose-100 hover:bg-white/[0.16]",
};

type ButtonVariant = keyof typeof variants;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  tooltip?: React.ReactNode;
  tooltipPlacement?: TooltipPlacement;
}

interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  tooltip?: React.ReactNode;
  tooltipPlacement?: TooltipPlacement;
}

export function buttonClassName(
  variant: ButtonVariant = "primary",
  className = "",
): string {
  return `${baseClasses} ${variants[variant]} ${className}`.trim();
}

export function Button({
  variant = "primary",
  className = "",
  title,
  tooltip,
  tooltipPlacement,
  ...props
}: ButtonProps) {
  const tooltipContent = tooltip ?? title;

  return (
    <Tooltip content={tooltipContent} placement={tooltipPlacement}>
      <button
        className={buttonClassName(variant, className)}
        aria-label={
          props["aria-label"] ?? (typeof title === "string" ? title : undefined)
        }
        {...props}
      />
    </Tooltip>
  );
}

export function ButtonLink({
  variant = "primary",
  className = "",
  title,
  tooltip,
  tooltipPlacement,
  ...props
}: ButtonLinkProps) {
  const tooltipContent = tooltip ?? title;

  return (
    <Tooltip content={tooltipContent} placement={tooltipPlacement}>
      <Link
        className={buttonClassName(variant, className)}
        aria-label={
          props["aria-label"] ?? (typeof title === "string" ? title : undefined)
        }
        {...props}
      />
    </Tooltip>
  );
}
