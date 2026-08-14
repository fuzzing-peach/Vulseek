import type { GetServerSidePropsContext } from "next";
import { validateRequest } from "@vulseek/server/lib/auth";

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
	const { user, session } = await validateRequest(context.req);
	if (!user || !session) {
		return { redirect: { destination: "/login", permanent: false } };
	}
	const pipelineId = String(context.query.pipelineId ?? "");
	const profileId = encodeURIComponent(String(context.query.profileId ?? ""));
	return {
		redirect: {
			destination: `/dashboard/pipelines/${pipelineId}?view=profiles&profileId=${profileId}`,
			permanent: false,
		},
	};
};

export default function LegacyPipelineProfileRoute() {
	return null;
}
