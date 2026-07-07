import type { GetServerSidePropsContext } from "next";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

interface AcceptInvitationProps {
	invitationId: string;
}

export const AcceptInvitation = ({
	invitationId,
}: AcceptInvitationProps) => {
	return (
		<div>
			<Button
				onClick={async () => {
					const result = await authClient.organization.acceptInvitation({
						invitationId,
					});
					console.log(result);
				}}
			>
				Accept Invitation
			</Button>
		</div>
	);
};

export default AcceptInvitation;

export async function getServerSideProps(
	ctx: GetServerSidePropsContext,
): Promise<{ props: AcceptInvitationProps } | { notFound: true }> {
	const invitationId = ctx.params?.["accept-invitation"];

	if (typeof invitationId !== "string") {
		return {
			notFound: true,
		};
	}

	return {
		props: {
			invitationId,
		},
	};
}
