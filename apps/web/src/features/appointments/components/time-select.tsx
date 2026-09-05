"use client";

import { SelectField } from "@/components/ui";

import { clockLabel, quarterHours, timeToMinutes } from "../appointments.time";

/**
 * A time, chosen the way a calendar offers one.
 *
 * Not `<input type="time">`. That control renders in the *browser's* locale — a machine set
 * to a 24-hour locale shows `21:30` however the rest of the page writes it — and there is no
 * attribute that changes it. So a page that has decided how a time reads cannot use it.
 *
 * Quarter hours, because that is the granularity an appointment is actually agreed at. The
 * list is filterable, so a time between them is reached by typing rather than by scrolling
 * ninety-six rows: the underlying select matches on the label, and "9:3" narrows to 9:30.
 *
 * A time already stored that is not on a quarter — one a drag produced, or a call took — is
 * added to the list so the field can show it. Dropping it would silently move an appointment
 * to the nearest quarter the moment somebody opened it.
 */
export const TimeSelect = ({
  label,
  value,
  onChange,
  error,
  hideLabel = false,
}: {
  readonly label: string;
  /** `HH:MM`, 24-hour — the value, which is not how it is written. */
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly error?: string | undefined;
  readonly hideLabel?: boolean;
}) => {
  const minutes = timeToMinutes(value);
  const quarters = quarterHours();
  const offList = minutes !== null && minutes % 15 !== 0;

  return (
    <SelectField
      label={label}
      hideLabel={hideLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={error}
      searchable
    >
      {offList && <option value={value}>{clockLabel(minutes)}</option>}
      {quarters.map((quarter) => (
        <option key={quarter.value} value={quarter.value}>
          {quarter.label}
        </option>
      ))}
    </SelectField>
  );
};
