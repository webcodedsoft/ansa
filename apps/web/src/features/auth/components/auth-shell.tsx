import type { ReactNode } from "react";

import { Ground } from "@/components/shell/ground";

/**
 * The frame around every way into the product.
 *
 * Signing in, creating an organisation and redeeming an invitation are three
 * different jobs wearing one face, so the face lives here. It carries the
 * ground itself because these pages sit outside the workspace layout — there
 * is no sidebar to render it for them.
 */
export const AuthShell = ({
  title,
  subtitle,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) => (
  <>
    <Ground />
    <main className="relative z-10 grid min-h-screen place-items-center p-6">
      <div className="glass w-full max-w-[396px] rounded-[22px] p-[30px]">
        <div className="mb-5">
          <span className="mb-4 grid size-[38px] place-items-center rounded-[11px] bg-[linear-gradient(150deg,var(--accent),color-mix(in_srgb,var(--accent)_55%,#2a6ad4))] text-base font-bold text-[var(--accent-on)] shadow-[var(--shadow-s)]">
            A
          </span>
          <h1 className="text-[22px] font-[650] tracking-[-0.028em]">{title}</h1>
          <p className="mt-1.5 text-[13.5px] text-[var(--ink-2)]">{subtitle}</p>
        </div>

        {children}

        {footer !== undefined && (
          <p className="mt-4 border-t border-[var(--hairline)] pt-4 text-[12.5px] text-[var(--ink-3)]">
            {footer}
          </p>
        )}
      </div>
    </main>
  </>
);
