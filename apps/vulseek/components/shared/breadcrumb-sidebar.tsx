import Link from "next/link";
import { Fragment } from "react";
import {
	Breadcrumb,
	BreadcrumbEllipsis,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
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
		<header className="relative z-20 flex h-16 shrink-0 items-center gap-2 bg-background transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
			<div className="flex w-full min-w-0 items-center justify-between">
				<div className="flex min-w-0 items-center gap-2">
					{sidebar ? <SidebarTrigger className="-ml-1 shrink-0" /> : null}
					{sidebar ? (
						<Separator orientation="vertical" className="mr-2 h-4 shrink-0" />
					) : null}
					<Breadcrumb className="min-w-0 overflow-hidden">
						<BreadcrumbList className="flex-nowrap overflow-hidden">
							{filteredList.map((item, index) => {
								const isCurrent = index === filteredList.length - 1;
								const isMiddle = index > 0 && !isCurrent;

								return (
									<Fragment
										key={`${item.href ?? "current"}:${item.name}:${index}`}
									>
										<BreadcrumbItem
											className={
												isMiddle ? "hidden min-w-0 sm:inline-flex" : "min-w-0"
											}
										>
											{isCurrent ? (
												<BreadcrumbPage
													className="block max-w-48 truncate"
													title={item.name}
												>
													{item.name}
												</BreadcrumbPage>
											) : item.href ? (
												<BreadcrumbLink
													asChild
													className="block max-w-40 truncate"
													title={item.name}
												>
													<Link href={item.href}>{item.name}</Link>
												</BreadcrumbLink>
											) : (
												<span className="block max-w-40 truncate" title={item.name}>
													{item.name}
												</span>
											)}
										</BreadcrumbItem>
										{index === 0 && filteredList.length > 2 ? (
											<>
												<BreadcrumbSeparator className="sm:hidden" />
												<BreadcrumbItem className="sm:hidden">
													<BreadcrumbEllipsis className="size-5" />
												</BreadcrumbItem>
												<BreadcrumbSeparator className="sm:hidden" />
											</>
										) : null}
										{!isCurrent ? (
											<BreadcrumbSeparator
												className={
													index === 0 && filteredList.length > 2
														? "hidden sm:block"
														: isMiddle
															? "hidden sm:block"
															: undefined
												}
											/>
										) : null}
									</Fragment>
								);
							})}
						</BreadcrumbList>
					</Breadcrumb>
				</div>
			</div>
		</header>
	);
};
