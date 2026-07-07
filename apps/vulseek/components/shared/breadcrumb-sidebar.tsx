import Link from "next/link";
import { Fragment } from "react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger, useOptionalSidebar } from "@/components/ui/sidebar";

interface Props {
	list: {
		name: string;
		href?: string;
	}[];
}

export const BreadcrumbSidebar = ({ list }: Props) => {
	const sidebar = useOptionalSidebar();
	const filteredList = list.filter((item) => item.name.trim());

	return (
		<header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
			<div className="flex items-center justify-between w-full">
				<div className="flex items-center gap-2">
						{sidebar ? <SidebarTrigger className="-ml-1" /> : null}
						{sidebar ? <Separator orientation="vertical" className="mr-2 h-4" /> : null}
						<Breadcrumb>
							<BreadcrumbList>
								{filteredList.map((item, index) => (
									<Fragment key={item.name}>
										<BreadcrumbItem className="block">
											<BreadcrumbLink href={item?.href} asChild={!!item?.href}>
											{item.href ? (
												<Link href={item?.href}>{item?.name}</Link>
											) : (
												item?.name
												)}
											</BreadcrumbLink>
										</BreadcrumbItem>
										{index + 1 < filteredList.length && (
											<BreadcrumbSeparator className="block" />
										)}
									</Fragment>
							))}
						</BreadcrumbList>
					</Breadcrumb>
				</div>
			</div>
		</header>
	);
};
