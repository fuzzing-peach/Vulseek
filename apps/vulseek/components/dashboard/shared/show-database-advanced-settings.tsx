import { ShowClusterSettings } from "@/components/dashboard/application/advanced/cluster/show-cluster-settings";
import { ShowResources } from "@/components/dashboard/application/advanced/show-resources";
import { ShowVolumes } from "@/components/dashboard/application/advanced/volumes/show-volumes";
import { ShowCustomCommand } from "@/components/dashboard/postgres/advanced/show-custom-command";
import {
	SectionNav,
	type SectionNavItem,
} from "@/components/dashboard/ui-system";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { useIsMobile } from "@/hooks/use-mobile";
import { RebuildDatabase } from "./rebuild-database";

interface Props {
	id: string;
	type: "postgres" | "mysql" | "mariadb" | "mongo" | "redis";
}

const SECTIONS: SectionNavItem[] = [
	{ id: "advanced-custom-command", label: "Custom Command" },
	{ id: "advanced-cluster", label: "Cluster Settings" },
	{ id: "advanced-volumes", label: "Volumes" },
	{ id: "advanced-resources", label: "Resources" },
	{ id: "advanced-danger", label: "Danger Zone", danger: true },
];

export const ShowDatabaseAdvancedSettings = ({ id, type }: Props) => {
	const isMobile = useIsMobile();
	return (
		<div className="md:grid md:grid-cols-[200px_minmax(0,1fr)] md:items-start md:gap-6">
			{!isMobile && (
				<div className="hidden md:sticky md:top-24 md:block">
					<SectionNav items={SECTIONS} />
				</div>
			)}
			{isMobile ? (
				<Accordion
					type="single"
					collapsible
					defaultValue="advanced-custom-command"
					className="flex w-full flex-col gap-5"
				>
					<AccordionItem
						value="advanced-custom-command"
						className="rounded-xl border bg-card"
					>
						<AccordionTrigger className="px-4 py-3.5 hover:no-underline sm:px-5">
							Custom Command
						</AccordionTrigger>
						<AccordionContent className="px-4 pb-4 sm:px-5">
							<ShowCustomCommand id={id} type={type} />
						</AccordionContent>
					</AccordionItem>
					<AccordionItem
						value="advanced-cluster"
						className="rounded-xl border bg-card"
					>
						<AccordionTrigger className="px-4 py-3.5 hover:no-underline sm:px-5">
							Cluster Settings
						</AccordionTrigger>
						<AccordionContent className="px-4 pb-4 sm:px-5">
							<ShowClusterSettings id={id} type={type} />
						</AccordionContent>
					</AccordionItem>
					<AccordionItem
						value="advanced-volumes"
						className="rounded-xl border bg-card"
					>
						<AccordionTrigger className="px-4 py-3.5 hover:no-underline sm:px-5">
							Volumes
						</AccordionTrigger>
						<AccordionContent className="px-4 pb-4 sm:px-5">
							<ShowVolumes id={id} type={type} />
						</AccordionContent>
					</AccordionItem>
					<AccordionItem
						value="advanced-resources"
						className="rounded-xl border bg-card"
					>
						<AccordionTrigger className="px-4 py-3.5 hover:no-underline sm:px-5">
							Resources
						</AccordionTrigger>
						<AccordionContent className="px-4 pb-4 sm:px-5">
							<ShowResources id={id} type={type} />
						</AccordionContent>
					</AccordionItem>
					<AccordionItem
						value="advanced-danger"
						className="rounded-xl border bg-card"
					>
						<AccordionTrigger className="px-4 py-3.5 hover:no-underline sm:px-5">
							Danger Zone
						</AccordionTrigger>
						<AccordionContent className="px-4 pb-4 sm:px-5">
							<RebuildDatabase id={id} type={type} />
						</AccordionContent>
					</AccordionItem>
				</Accordion>
			) : (
				<div className="flex w-full flex-col gap-5">
					<div id="advanced-custom-command" className="scroll-mt-24">
						<ShowCustomCommand id={id} type={type} />
					</div>
					<div id="advanced-cluster" className="scroll-mt-24">
						<ShowClusterSettings id={id} type={type} />
					</div>
					<div id="advanced-volumes" className="scroll-mt-24">
						<ShowVolumes id={id} type={type} />
					</div>
					<div id="advanced-resources" className="scroll-mt-24">
						<ShowResources id={id} type={type} />
					</div>
					<div id="advanced-danger" className="scroll-mt-24">
						<RebuildDatabase id={id} type={type} />
					</div>
				</div>
			)}
		</div>
	);
};
