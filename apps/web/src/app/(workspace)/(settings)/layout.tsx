import type { ReactNode } from "react";

import { SettingsTabs } from "@/components/shell/settings-tabs";
import { currentPrincipal } from "@/features/auth/auth.service";
import { withSession } from "@/lib/api/server";

/**
 * Settings: eight pages behind one sidebar row.
 *
 * A route group rather than a `/settings` prefix, so every URL that was linked, bookmarked
 * or written into an email stays exactly what it was — `/members` is still `/members`. What
 * the group adds is the strip of tabs across the top, which is where these pages are
 * navigated between now that the sidebar no longer lists them one by one.
 */
const SettingsLayout = async ({ children }: { readonly children: ReactNode }) => {
  const me = await withSession(currentPrincipal);
  return (
    <>
      <SettingsTabs capabilities={me.capabilities} />
      {children}
    </>
  );
};

export default SettingsLayout;
