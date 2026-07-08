"use client";

import { FileCode2 } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

export const ScanPipelineYamlViewer = () => {
	const { data, isLoading, isError, error } = api.scan.pipelineYaml.useQuery();

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex items-center gap-2">
					<FileCode2 className="size-5 text-muted-foreground" />
					Scan Pipeline YAML
				</CardTitle>
				<CardDescription>
					Read-only view of the active scan pipeline definitions.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
						Loading YAML definition...
					</div>
				) : isError ? (
					<div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/60 dark:bg-red-950/30 dark:text-red-100">
						{error?.message || "Failed to load scan pipeline YAML."}
					</div>
				) : (
					<pre className="max-h-[520px] overflow-auto rounded-lg border bg-muted/30 p-4 text-xs leading-relaxed">
						<code>{data?.yaml ?? ""}</code>
					</pre>
				)}
			</CardContent>
		</Card>
	);
};
