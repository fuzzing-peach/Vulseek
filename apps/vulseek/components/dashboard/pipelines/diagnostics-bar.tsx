import { AlertCircle, AlertTriangle } from "lucide-react";
import type { PipelineDiagnostic } from "@vulseek/server/services/scan/pipeline/document-v3";

/**
 * Bottom diagnostics bar. Clicking an item passes the full diagnostic so the
 * workbench can focus the referenced entity or reveal the source location.
 */
export type DiagnosticsBarProps = {
	diagnostics: PipelineDiagnostic[];
	onSelect?: (diagnostic: PipelineDiagnostic) => void;
};

export const DiagnosticsBar = ({ diagnostics, onSelect }: DiagnosticsBarProps) => {
	if (diagnostics.length === 0) {
		return (
			<div className="flex h-8 shrink-0 items-center border-t px-3 text-xs text-muted-foreground">
				No diagnostics — pipeline is ready to publish.
			</div>
		);
	}
	return (
		<div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-t px-2">
			{diagnostics.map((diagnostic, index) => (
				<button
					key={`${diagnostic.code}-${index}`}
					type="button"
					disabled={!onSelect}
					onClick={() => onSelect?.(diagnostic)}
					className={
						"inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs " +
						(diagnostic.severity === "error"
							? "bg-red-500/10 text-red-600"
							: "bg-amber-500/10 text-amber-600") +
						(onSelect
							? " cursor-pointer hover:opacity-80"
							: " cursor-default")
					}
				>
					{diagnostic.severity === "error" ? (
						<AlertCircle className="size-3" />
					) : (
						<AlertTriangle className="size-3" />
					)}
					<span className="max-w-64 truncate">{diagnostic.message}</span>
				</button>
			))}
		</div>
	);
};
