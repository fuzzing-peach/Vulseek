"use client";

import { ClipboardCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

const SECURITY_POLICY_PLACEHOLDER = `# In scope
- ...

# Out of scope
- ...

# Do not report
- ...`;

export const SecurityPolicyCard = ({
	value,
	onSave,
}: {
	value?: string | null;
	onSave: (securityPolicy: string) => Promise<void>;
}) => {
	const [securityPolicy, setSecurityPolicy] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		setSecurityPolicy(value ?? "");
	}, [value]);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex items-center gap-2">
					<ClipboardCheck className="size-5 text-muted-foreground" />
					Security Policy
				</CardTitle>
				<CardDescription>
					Define in-scope assets, out-of-scope behavior, threat model
					assumptions, and rules the scanner must follow.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="grid gap-3">
					<Textarea
						value={securityPolicy}
						onChange={(event) => setSecurityPolicy(event.currentTarget.value)}
						placeholder={SECURITY_POLICY_PLACEHOLDER}
						className="min-h-56 font-mono text-sm"
						spellCheck={false}
					/>
					<div className="flex justify-end">
						<Button
							type="button"
							disabled={isSaving}
							onClick={async () => {
								setIsSaving(true);
								try {
									await onSave(securityPolicy);
									toast.success("Security policy updated");
								} catch {
									toast.error("Failed to update security policy");
								} finally {
									setIsSaving(false);
								}
							}}
						>
							Save
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
};
