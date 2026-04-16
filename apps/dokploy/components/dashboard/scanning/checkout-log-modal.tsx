import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	logs: string;
	isLoading?: boolean;
}

export const CheckoutLogModal = ({
	open,
	onOpenChange,
	title,
	description,
	logs,
	isLoading,
}: Props) => {
	const logContainerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const container = logContainerRef.current;
		if (!container) return;
		container.scrollTop = container.scrollHeight;
	}, [open, logs, isLoading]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-5xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description || "Docker build logs"}</DialogDescription>
				</DialogHeader>
				<div
					ref={logContainerRef}
					className="rounded-md border bg-black text-green-200 p-3 h-[60vh] overflow-auto text-xs whitespace-pre-wrap font-mono"
				>
					{isLoading ? (
						<div className="flex items-center gap-2 text-zinc-300">
							<Loader2 className="size-4 animate-spin" />
							Running checkout and image build...
						</div>
					) : (
						logs
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
};
