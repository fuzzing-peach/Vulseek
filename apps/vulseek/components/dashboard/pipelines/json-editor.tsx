import { json as jsonLanguage } from "@codemirror/lang-json";
import CodeMirror from "@uiw/react-codemirror";
import * as React from "react";

/**
 * Embedded JSON editor for arbitrary JSON Schema, edge `input` and
 * `promptValues`. Commits only valid JSON; invalid JSON shows an error hint
 * and keeps the previous committed value.
 */

export type JsonEditorProps = {
	value: unknown;
	onChange: (value: unknown) => void;
	label?: string;
	rows?: number;
};

export const JsonEditor = ({ value, onChange, label, rows = 6 }: JsonEditorProps) => {
	const [text, setText] = React.useState(() => JSON.stringify(value ?? {}, null, 2));
	const [error, setError] = React.useState<string | null>(null);
	const committedRef = React.useRef(value);

	React.useEffect(() => {
		// External value change (e.g. undo/redo) → resync the text.
		if (JSON.stringify(value) !== JSON.stringify(committedRef.current)) {
			setText(JSON.stringify(value ?? {}, null, 2));
			committedRef.current = value;
			setError(null);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value]);

	const handleChange = (next: string) => {
		setText(next);
		if (next.trim() === "") {
			onChange({});
			committedRef.current = {};
			setError(null);
			return;
		}
		try {
			const parsed = JSON.parse(next);
			onChange(parsed);
			committedRef.current = parsed;
			setError(null);
		} catch (parseError) {
			setError(parseError instanceof Error ? parseError.message : "Invalid JSON");
		}
	};

	return (
		<div className="space-y-1">
			{label ? <div className="text-xs text-muted-foreground">{label}</div> : null}
			<div className="overflow-hidden rounded-md border">
				<CodeMirror
					value={text}
					onChange={handleChange}
					extensions={[jsonLanguage()]}
					height={`${Math.max(rows * 16, 96)}px`}
					basicSetup={{ lineNumbers: true, foldGutter: true }}
				/>
			</div>
			{error ? (
				<p className="text-[11px] text-red-600">{error}</p>
			) : null}
		</div>
	);
};
