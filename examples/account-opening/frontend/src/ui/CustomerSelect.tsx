interface CustomerSelectProps {
  name: string;
  label: string;
  required?: boolean;
}

export function CustomerSelect(props: CustomerSelectProps) {
  return <div role="combobox" aria-label={props.label} data-field-path={props.name} />;
}
