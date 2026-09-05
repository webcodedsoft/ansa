import { SelectField } from "@/components/ui";

import { ianaZones } from "../appointments.time";

/**
 * The IANA-zone picker.
 *
 * The list comes from `Intl.supportedValuesOf`, which answers the same on the server and in
 * the browser, so the rendered `<select>` matches on both sides and hydration is quiet. The
 * home zone is hoisted to the top because almost every calendar here is a Nigerian one, and
 * making somebody scroll past three hundred zones to reach the common one is the small daily
 * cruelty this hoist removes.
 *
 * Not a client component: it holds no state, reads `defaultValue`, and the choosing is the
 * native select's own. The form it sits in owns the value.
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
