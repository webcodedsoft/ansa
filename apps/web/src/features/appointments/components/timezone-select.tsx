import { SelectField } from "@/components/ui";

import { ianaZones } from "../appointments.time";

/**
 * The IANA-zone picker.
 *
 * The list comes from `Intl.supportedValuesOf`, which answers the same on the server and in
 * the browser, so both sides agree on the options and hydration is quiet. The home zone is
 * hoisted to the top because almost every calendar here is a Nigerian one.
 *
 * This is the list that most wanted a select you can type into — three hundred zones is not a
 * list anybody finds `Africa/Lagos` in by scrolling, and the hoist above was the workaround
 * for exactly that. `SelectField` filters as you type now, so the hoist is a convenience
 * rather than the only way through.
 *
 * Still not a client component itself: it holds no state and reads `defaultValue`, and the
 * form it sits in owns the value. The control it renders is a client one, which a server
 * component may render.
 */
export const TimezoneSelect = ({
  name = "timezone",
  defaultValue = "Africa/Lagos",
  error,
  hint,
  disabled = false,
}: {
  readonly name?: string;
  readonly defaultValue?: string;
  readonly error?: string | undefined;
  readonly hint?: string;
  readonly disabled?: boolean;
}) => (
  <SelectField
    label="Timezone"
    name={name}
    defaultValue={defaultValue}
    required
    error={error}
    disabled={disabled}
    hint={hint ?? "The zone the hours, slots and bookings are read in. It cannot be guessed from a caller."}
  >
    {ianaZones().map((zone) => (
      <option key={zone} value={zone}>
        {zone}
      </option>
    ))}
  </SelectField>
);
