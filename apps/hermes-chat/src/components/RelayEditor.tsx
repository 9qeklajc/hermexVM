interface RelayEditorProps {
  value: string;
  valid: boolean;
  onChange: (value: string) => void;
  rows?: number;
}

export function RelayEditor({
  value,
  valid,
  onChange,
  rows = 3,
}: RelayEditorProps) {
  return (
    <>
      <label className="identity-field relay-editor">
        <span className="identity-label">Relays</span>
        <span className="field-help">Enter one relay URL per line.</span>
        <textarea
          rows={rows}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={!valid}
          placeholder={"wss://relay.example\nwss://another-relay.example"}
        />
      </label>
      {!valid ? (
        <div className="form-error">
          Enter at least one valid ws:// or wss:// relay URL.
        </div>
      ) : null}
    </>
  );
}
