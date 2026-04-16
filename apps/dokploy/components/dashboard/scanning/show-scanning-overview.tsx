import { SearchCode, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
	resourceId: string;
	resourceType: "application" | "compose";
}

export const ShowScanningOverview = ({ resourceId, resourceType }: Props) => {
	return (
		<div className="flex flex-col gap-4">
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<SearchCode className="size-5 text-muted-foreground" />
						Scanning Overview
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="secondary">Target: {resourceType}</Badge>
						<Badge variant="outline">ID: {resourceId}</Badge>
						<Badge>Mode: Vulnerability Analysis</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						This tab is reserved for scan orchestration and vulnerability
						analysis workflows. It is separated from deployment controls so scan
						jobs and findings can be managed independently.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="default" disabled>
							Run Delta Scan
						</Button>
						<Button variant="secondary" disabled>
							Run Full Scan
						</Button>
					</div>
				</CardContent>
			</Card>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-lg flex items-center gap-2">
						<ShieldAlert className="size-4 text-muted-foreground" />
						Planned Workflow
					</CardTitle>
				</CardHeader>
				<CardContent className="text-sm text-muted-foreground space-y-1">
					<p>1. Build ScanJob and VulnerabilityCandidate queue.</p>
					<p>2. Run candidate-level analysis with autonomous agents.</p>
					<p>3. Aggregate findings and evidence into report artifacts.</p>
				</CardContent>
			</Card>
		</div>
	);
};

