import { FileIcon, Loader2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import {
	type DirectoryCacheEntry,
	type DirectoryListItem,
	LazyFileTree,
	ROOT_DIRECTORY_KEY,
} from "@/components/dashboard/scanning/scan-lazy-file-tree";
import type { RouterOutputs } from "@/utils/api";
import { scanT } from "./scan-i18n";

type ScanJobFilesTabProps = {
	scanJobId: string;
	directoryCache: Record<string, DirectoryCacheEntry>;
	rootDirectoryLoading: boolean;
	expandedDirectories: Record<string, boolean>;
	selectedFilePath: string | null;
	onToggleDirectory: (directoryPath: string) => void;
	onSelectFile: (filePath: string | null) => void;
	selectedFile: RouterOutputs["scan"]["readFile"] | undefined;
	isLoadingSelectedFile: boolean;
};

/**
 * Scan job context file browser (Phase 4 split from show-scan-job-detail).
 * Renders the LazyFileTree plus the selected-file viewer. State lives in the
 * page/context query controller; this component is presentational.
 */
export const ScanJobFilesTab = ({
	scanJobId,
	directoryCache,
	rootDirectoryLoading,
	expandedDirectories,
	selectedFilePath,
	onToggleDirectory,
	onSelectFile,
	selectedFile,
	isLoadingSelectedFile,
}: ScanJobFilesTabProps) => {
	const { t } = useTranslation("scan");
	const rootStatus: DirectoryCacheEntry["status"] =
		directoryCache[ROOT_DIRECTORY_KEY]?.status ||
		(rootDirectoryLoading ? "loading" : "idle");
	const rootItems: DirectoryListItem[] =
		directoryCache[ROOT_DIRECTORY_KEY]?.items || [];

	return (
		<div className="rounded-lg border">
			<div className="border-b px-4 py-3">
				<div className="font-medium">{scanT(t, "scan.files.title", "Files")}</div>
				<div className="text-sm text-muted-foreground">
					{scanT(
						t,
						"scan.files.jobDescription",
						"Browse scan job context files.",
					)}
				</div>
			</div>
			<div className="grid min-h-[65vh] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
				<div className="border-b lg:border-b-0 lg:border-r">
					<LazyFileTree
						rootItems={rootItems}
						rootStatus={rootStatus}
						expandedDirectories={expandedDirectories}
						selectedFilePath={selectedFilePath}
						directoryCache={directoryCache}
						onToggleDirectory={onToggleDirectory}
						onSelectFile={onSelectFile}
					/>
				</div>

				<div className="min-w-0">
					<div className="border-b px-4 py-3">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<FileIcon className="size-4" />
							<span className="truncate">
								{selectedFile?.relativePath ||
									selectedFilePath ||
									scanT(t, "scan.files.noFileSelected", "No file selected")}
							</span>
						</div>
					</div>
					<div className="max-h-[calc(65vh-49px)] overflow-auto px-4 py-3">
						{!selectedFilePath ? (
							<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
								<FileIcon className="size-6" />
								{scanT(t, "scan.files.noFileSelected", "No file selected")}
							</div>
						) : isLoadingSelectedFile ? (
							<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
								<Loader2 className="size-4 animate-spin" />
								{scanT(t, "scan.files.loadingFile", "Loading file...")}
							</div>
						) : (
							<pre className="whitespace-pre-wrap break-words font-mono text-sm">
								{selectedFile?.content ||
									scanT(t, "scan.files.emptyFile", "(empty)")}
							</pre>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};
