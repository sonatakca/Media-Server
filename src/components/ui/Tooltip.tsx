import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  children: ReactElement;
  content?: ReactNode;
  placement?: TooltipPlacement;
  disabled?: boolean;
}

interface TooltipPosition {
  left: number;
  top: number;
}

function assignRef<TValue>(ref: Ref<TValue> | undefined, value: TValue) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  (ref as { current: TValue }).current = value;
}

function getTooltipPosition(
  triggerRect: DOMRect,
  tooltipRect: DOMRect,
  placement: TooltipPlacement,
): TooltipPosition {
  const gap = 8;
  const viewportMargin = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let resolvedPlacement = placement;

  if (
    placement === "top" &&
    triggerRect.top - tooltipRect.height - gap < viewportMargin
  ) {
    resolvedPlacement = "bottom";
  } else if (
    placement === "bottom" &&
    triggerRect.bottom + tooltipRect.height + gap >
      viewportHeight - viewportMargin
  ) {
    resolvedPlacement = "top";
  } else if (
    placement === "left" &&
    triggerRect.left - tooltipRect.width - gap < viewportMargin
  ) {
    resolvedPlacement = "right";
  } else if (
    placement === "right" &&
    triggerRect.right + tooltipRect.width + gap > viewportWidth - viewportMargin
  ) {
    resolvedPlacement = "left";
  }

  let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
  let top = triggerRect.top - tooltipRect.height - gap;

  if (resolvedPlacement === "bottom") {
    top = triggerRect.bottom + gap;
  } else if (resolvedPlacement === "left") {
    left = triggerRect.left - tooltipRect.width - gap;
    top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
  } else if (resolvedPlacement === "right") {
    left = triggerRect.right + gap;
    top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
  }

  return {
    left: Math.min(
      Math.max(left, viewportMargin),
      viewportWidth - tooltipRect.width - viewportMargin,
    ),
    top: Math.min(
      Math.max(top, viewportMargin),
      viewportHeight - tooltipRect.height - viewportMargin,
    ),
  };
}

export function Tooltip({
  children,
  content,
  placement = "top",
  disabled = false,
}: TooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const lastPointerTypeRef = useRef<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const hasContent = Boolean(content);

  useEffect(() => {
    if (!hasContent || disabled) {
      setIsVisible(false);
      return;
    }

    const trigger = triggerRef.current;

    if (!trigger) {
      return;
    }

    const show = () => {
      setPosition(null);
      setIsVisible(true);
    };
    const hide = () => setIsVisible(false);
    const handlePointerEnter = (event: globalThis.PointerEvent) => {
      lastPointerTypeRef.current = event.pointerType;

      if (event.pointerType !== "touch") {
        show();
      }
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      lastPointerTypeRef.current = event.pointerType;

      if (event.pointerType === "touch") {
        hide();
      }
    };
    const handleMouseEnter = () => {
      if (lastPointerTypeRef.current !== "touch") {
        show();
      }
    };
    const handleFocusIn = () => {
      if (lastPointerTypeRef.current !== "touch") {
        show();
      }
    };

    trigger.addEventListener("pointerenter", handlePointerEnter);
    trigger.addEventListener("pointerleave", hide);
    trigger.addEventListener("pointerdown", handlePointerDown);
    trigger.addEventListener("mouseenter", handleMouseEnter);
    trigger.addEventListener("mouseleave", hide);
    trigger.addEventListener("focusin", handleFocusIn);
    trigger.addEventListener("focusout", hide);

    return () => {
      trigger.removeEventListener("pointerenter", handlePointerEnter);
      trigger.removeEventListener("pointerleave", hide);
      trigger.removeEventListener("pointerdown", handlePointerDown);
      trigger.removeEventListener("mouseenter", handleMouseEnter);
      trigger.removeEventListener("mouseleave", hide);
      trigger.removeEventListener("focusin", handleFocusIn);
      trigger.removeEventListener("focusout", hide);
    };
  }, [disabled, hasContent]);

  useLayoutEffect(() => {
    if (!isVisible || !hasContent) {
      return;
    }

    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;

    if (!trigger || !tooltip) {
      return;
    }

    const updatePosition = () => {
      setPosition(
        getTooltipPosition(
          trigger.getBoundingClientRect(),
          tooltip.getBoundingClientRect(),
          placement,
        ),
      );
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [hasContent, isVisible, placement, content]);

  if (!isValidElement(children) || !hasContent || disabled) {
    return children;
  }

  const child = children as ReactElement<{
    ref?: Ref<HTMLElement>;
    title?: string;
  }>;

  const trigger = cloneElement(child, {
    // Native title attributes are intentionally stripped here so Seyirlik never
    // shows both a browser tooltip and the custom glass tooltip.
    title: undefined,
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      assignRef(child.props.ref, node);
    },
  });

  return (
    <>
      {trigger}
      {isVisible && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              className={`pointer-events-none fixed z-[9999] max-w-[17rem] origin-center rounded-md border border-white/10 bg-zinc-950/90 px-2.5 py-1.5 text-xs font-semibold leading-snug text-white/92 opacity-0 shadow-[0_18px_58px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl transition-[opacity,transform] duration-100 ${
                position ? "scale-100 opacity-100" : "scale-95 translate-y-0.5"
              }`}
              style={
                position
                  ? {
                      left: position.left,
                      top: position.top,
                    }
                  : {
                      left: 0,
                      top: 0,
                    }
              }
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
