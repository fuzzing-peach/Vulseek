import { ChevronRight, FileIcon, Folder, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "next-i18next";
import { cn } from "@/lib/utils";
import { scanT } from "./scan-i18n";

export type DirectoryListItem = {
	id: string;
	name: string;
	type: "directory" | "file";
	hasChildren?: boolean;
};
export type DirectoryCacheEntry = {
	items: DirectoryListItem[];
	status: "idle" | "loading" | "loaded" | "error";
};

export const ROOT_DIRECTORY_KEY = "__root__";

export const LazyFileTree = (props: {
	rootItems: DirectoryListItem[];
	rootStatus: DirectoryCacheEntry["status"];
	expandedDirectories: Record<string, boolean>;
	selectedFilePath: string | null;
	directoryCache: Record<string, DirectoryCacheEntry>;
	onToggleDirectory: (directoryPath: string) => void;
	onSelectFile: (filePath: string) => void;
}) => {
	const { t } = useTranslation("scan");
	const renderItems = (items: DirectoryListItem[], depth = 0): ReactNode =>
		items.map((item) => {
			const directory = item.type === "directory";
			const expanded = Boolean(props.expandedDirectories[item.id]);
			const cache = props.directoryCache[item.id];
			return (
				<div key={item.id}>
					<button
						type="button"
						onClick={() =>
							directory
								? props.onToggleDirectory(item.id)
								: props.onSelectFile(item.id)
						}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/70",
							!directory && props.selectedFilePath === item.id && "bg-accent text-accent-foreground",
						)}
						style={{ paddingLeft: `${depth * 14 + 10}px` }}
					>
						{directory ? <ChevronRight className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-90")} /> : <span className="size-4 shrink-0" />}
						{directory ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
						<span className="min-w-0 truncate font-mono text-sm">{item.name}</span>
					</button>
					{directory && expanded ? (
						cache?.status === "loading" ? <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{scanT(t, "scan.files.loadingShort", "Loading...")}</div> :
						cache?.status === "error" ? <div className="px-3 py-2 text-sm text-destructive">{scanT(t, "scan.files.directoryLoadError", "Failed to load directory")}</div> :
						<div>{renderItems(cache?.items || [], depth + 1)}</div>
					) : null}
				</div>
			);
		});
	if (props.rootStatus === "loading") return <div className="flex min-h-[320px] items-center justify-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{scanT(t, "scan.files.loading", "Loading files...")}</div>;
	if (props.rootStatus === "error") return <div className="flex min-h-[320px] items-center justify-center text-destructive">{scanT(t, "scan.files.loadError", "Failed to load files")}</div>;
	if (!props.rootItems.length) return <div className="flex min-h-[320px] items-center justify-center text-muted-foreground">{scanT(t, "scan.files.empty", "No files available")}</div>;
	return <div className="h-[65vh] overflow-auto p-2">{renderItems(props.rootItems)}</div>;
};
