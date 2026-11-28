/**
 * The session's scratch folder, pure half (./scratch.ts wires it): one short per-turn prompt section naming the
 * folder OMPdesk made for this tab's throwaway files (main `src/main/session-scratch.ts`, which also says why it is
 * not the temp folder). Without it agents write screenshots, test output and probes to `/tmp`, the home folder or
 * the repository by hard-coded path, where nothing can tie them to a session afterwards (measured:
 * machine-setup-updates › Disk care).
 *
 * Dependency-free: main imports the variable's name.
 */

/** The tab's scratch folder, an absolute path; set per spawn by main (`sessionEnv`). */
export const SCRATCH_ENV = "OMP_GUI_SCRATCH";

export const SCRATCH_SECTION_ID = "scratch";

/** The section for a session whose omp was given `dir`, or undefined for none. */
export function scratchSection(dir: string | undefined): string | undefined {
	if (!dir) return undefined;
	return `<scratch>
Keep throwaway files you create under \`${dir}\`, not in the repo, home or system temp. Run the project's own checker as documented: it may create and remove its working folders and write output in the locations it requires. After verification, remove your own unneeded build output and downloads; keep files that replies link or ongoing work needs. OMPdesk later sweeps closed tabs' scratch and keeps linked files until their sessions are deleted.
</scratch>`;
}
