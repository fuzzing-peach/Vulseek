import { Trash2 } from "lucide-react";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";

/**
 * Destructive confirm for pruning a dataset profile. The trash trigger only
 * opens the AlertDialog — the destructive prune runs on Confirm, so an
 * accidental click can never delete prepared samples.
 */
export const PruneProfileDialog = ({
	profileKey,
	onConfirm,
	disabled,
}: {
	profileKey: string;
	onConfirm: () => void;
	disabled?: boolean;
}) => {
	return (
		<DialogAction
			title="Prune Profile"
			description={
				<>
					Are you sure you want to prune "{profileKey}"? Its prepared samples
					and the files checked out for evaluations will be permanently
					deleted.{" "}
					<strong>This action cannot be undone.</strong>
				</>
			}
			type="destructive"
			disabled={disabled}
			onClick={onConfirm}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="absolute bottom-3 right-3 size-8 text-destructive opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10"
				aria-label={`Prune profile ${profileKey}`}
				title="Prune profile"
				disabled={disabled}
				onClick={(event) => event.stopPropagation()}
			>
				<Trash2 className="size-4" />
			</Button>
		</DialogAction>
	);
};
