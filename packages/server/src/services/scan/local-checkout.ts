const localRepositorySourceStage = `FROM \${VULSEEK_TOOLS_IMAGE} AS repository-source

WORKDIR /workspace

RUN mkdir -p /workspace/repo`;

export const buildLocalCheckoutDockerfile = (template: string) =>
	template.replace(
		/FROM \$\{VULSEEK_TOOLS_IMAGE\} AS repository-source[\s\S]*?(?=FROM )/,
		`${localRepositorySourceStage}\n\n`,
	);

export const buildLocalRepositoryPopulateScript = () => `set -e
mkdir -p /workspace/repo
cp -a /tmp/localrepo/. /workspace/repo/
if [ -n "$POST_CHECKOUT_SCRIPT" ]; then
  printf '%s\n' "$POST_CHECKOUT_SCRIPT" > /tmp/vulseek-post-checkout.sh
  cd /workspace/repo
  bash /tmp/vulseek-post-checkout.sh
  rm -f /tmp/vulseek-post-checkout.sh
fi
cd /workspace/repo
git config --global --add safe.directory /workspace/repo
if [ ! -d .git ]; then
  git init
  git config user.email 'local@vulseek'
  git config user.name 'Local Source'
  git add -A
  git commit -m 'local source snapshot' --allow-empty
fi
echo '[checkout] local copy complete'`;
