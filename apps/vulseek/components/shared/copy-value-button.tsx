"use client";

import copy from "copy-to-clipboard";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface Props {
	value: string;
	label?: string;
	className?: string;
}

export const CopyValueButton = ({ value, label = "Value", className }: Props) => {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) {
			return;
		}

		const timer = window.setTimeout(() => setCopied(false), 1200);
		return () => window.clearTimeout(timer);
	}, [copied]);

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className={className}
			onClick={() => {
				if (!value) {
					toast.error(`${label} is empty`);
					return;
				}

				if (!copy(value)) {
					toast.error(`Failed to copy ${label.toLowerCase()}`);
					return;
				}

				setCopied(true);
				toast.success(`${label} copied`);
			}}
			title={`Copy ${label}`}
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
		</Button>
	);
};
