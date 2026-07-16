import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildLocalCheckoutDockerfile,
	buildLocalRepositoryPopulateScript,
} from "./local-checkout";

describe("local checkout", () => {
	it("builds an empty repository stage without reading the local path", () => {
		const template = `FROM \${VULSEEK_TOOLS_IMAGE} AS repository-source
RUN git clone example /workspace/repo

FROM \${VULSEEK_TOOLS_IMAGE} AS final
COPY --from=repository-source /workspace/repo /workspace/repo`;

		const dockerfile = buildLocalCheckoutDockerfile(template);

		assert.match(dockerfile, /RUN mkdir -p \/workspace\/repo/);
		assert.doesNotMatch(dockerfile, /COPY repo/);
		assert.doesNotMatch(dockerfile, /git clone/);
	});

	it("runs the post-checkout script after the bind-mounted source is copied", () => {
		const script = buildLocalRepositoryPopulateScript();
		const copyIndex = script.indexOf("cp -a /tmp/localrepo/. /workspace/repo/");
		const postCheckoutIndex = script.indexOf('if [ -n "$POST_CHECKOUT_SCRIPT" ]');

		assert.ok(copyIndex >= 0);
		assert.ok(postCheckoutIndex > copyIndex);
	});
});
