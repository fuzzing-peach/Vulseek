import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import CodeMirror from "@uiw/react-codemirror";
import * as React from "react";
import type { PipelineDiagnostic } from "@vulseek/server/services/scan/pipeline/document-v3";

/**
 * YAML mode editor. Raw text is the single source of truth for saving;
 * parsing happens on a debounce so the canvas follows the last valid
 * document without blocking keystrokes.
 */

export type YamlEditorProps = {
	value: string;
	onChange: (value: string) => void;
	diagnostics: PipelineDiagnostic[];
	readOnly?: boolean;
};

export const YamlEditor = ({
	value,
	onChange,
	diagnostics,
	readOnly = false,
}: YamlEditorProps) => {
	const [localValue, setLocalValue] = React.useState(value);
	React.useEffect(() => setLocalValue(value), [value]);

	// Debounce the buffer update so parse + canvas refresh happen off-keystroke.
	const debouncedChange = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const handleChange = React.useCallback(
		(next: string) => {
			setLocalValue(next);
			if (debouncedChange.current) clearTimeout(debouncedChange.current);
			debouncedChange.current = setTimeout(() => onChange(next), 250);
		},
		[onChange],
	);

	const errors = diagnostics.filter((d) => d.severity === "error");
	const warnings = diagnostics.filter((d) => d.severity === "warning");

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
				<span className="font-medium">pipeline.yaml</span>
				<span className="flex items-center gap-3">
					{errors.length > 0 && (
						<span className="text-red-600">{errors.length} errors</span>
					)}
					{warnings.length > 0 && (
						<span className="text-amber-600">{warnings.length} warnings</span>
					)}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<CodeMirror
					value={localValue}
					onChange={handleChange}
					extensions={[yamlLanguage()]}
					readOnly={readOnly}
					height="100%"
					basicSetup={{
						lineNumbers: true,
						foldGutter: true,
						highlightActiveLine: true,
					}}
				/>
			</div>
		</div>
	);
};
