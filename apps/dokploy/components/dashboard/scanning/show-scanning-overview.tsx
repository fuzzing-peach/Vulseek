import { SearchCode, ShieldAlert } from "lucide-react";
import { useTranslation } from "next-i18next";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatResourceTypeLabel, scanT } from "./scan-i18n";

interface Props {
	resourceId: string;
	resourceType: "application" | "compose";
}

export const ShowScanningOverview = ({ resourceId, resourceType }: Props) => {
	const { t } = useTranslation("scan");
	return (
		<div className="flex flex-col gap-4">
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<SearchCode className="size-5 text-muted-foreground" />
						{scanT(t, "scan.overview.title", "Scanning Overview")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="secondary">
							{scanT(t, "scan.overview.target", "Target: {{type}}", {
								type: formatResourceTypeLabel(t, resourceType),
							})}
						</Badge>
						<div className="flex items-center gap-1 rounded-md border px-2 py-0.5">
							<Badge variant="outline" className="border-0 px-0">
								{scanT(t, "scan.overview.id", "ID: {{id}}", {
									id: resourceId,
								})}
							</Badge>
							<CopyValueButton
								value={resourceId}
								label={scanT(t, "scan.overview.resourceId", "Resource ID")}
								className="size-6"
							/>
						</div>
						<Badge>
							{scanT(t, "scan.overview.mode", "Mode: Vulnerability Analysis")}
						</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						{scanT(
							t,
							"scan.overview.description",
							"This tab is reserved for scan orchestration and vulnerability analysis workflows. It is separated from deployment controls so scan jobs and findings can be managed independently.",
						)}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="secondary" disabled>
							{scanT(t, "scan.overview.runFullScan", "Run Full Scan")}
						</Button>
					</div>
				</CardContent>
			</Card>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-lg flex items-center gap-2">
						<ShieldAlert className="size-4 text-muted-foreground" />
						{scanT(t, "scan.overview.workflow", "Planned Workflow")}
					</CardTitle>
				</CardHeader>
				<CardContent className="text-sm text-muted-foreground space-y-1">
					<p>
						{scanT(
							t,
							"scan.overview.step1",
							"1. Build ScanJob and VulnerabilityCandidate queue.",
						)}
					</p>
					<p>
						{scanT(
							t,
							"scan.overview.step2",
							"2. Run candidate-level analysis with autonomous agents.",
						)}
					</p>
					<p>
						{scanT(
							t,
							"scan.overview.step3",
							"3. Aggregate findings and evidence into report artifacts.",
						)}
					</p>
				</CardContent>
			</Card>
		</div>
	);
};
