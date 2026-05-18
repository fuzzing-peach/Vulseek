import { useSyncExternalStore } from "react";

const subscribers = new Set<() => void>();
let openCount = 0;

const emit = () => {
	for (const subscriber of subscribers) {
		subscriber();
	}
};

export const setSandboxAgentOutputModalOpen = (open: boolean) => {
	const nextOpenCount = open ? openCount + 1 : Math.max(0, openCount - 1);
	if (nextOpenCount === openCount) {
		return;
	}
	openCount = nextOpenCount;
	emit();
};

export const useIsSandboxAgentOutputModalOpen = () =>
	useSyncExternalStore(
		(subscriber) => {
			subscribers.add(subscriber);
			return () => {
				subscribers.delete(subscriber);
			};
		},
		() => openCount > 0,
		() => false,
	);
