interface CustomerSelectProps {
  name: string;
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
}

export function CustomerSelect(props: CustomerSelectProps) {
  return (
    <select
      name={props.name}
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      required={props.required}
    >
      <option value="">Select an approved customer</option>
    </select>
  );
}
