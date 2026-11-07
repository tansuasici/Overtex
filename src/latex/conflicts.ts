// Detecting a double build when LaTeX Workshop is installed next to Overtex.

export const LATEX_WORKSHOP_ID = 'James-Yu.latex-workshop';
export const LW_AUTOBUILD_SETTING = 'latex.autoBuild.run';

export interface ConflictInputs {
  latexWorkshopInstalled: boolean;
  /** Value of `latex-workshop.latex.autoBuild.run`; undefined means its default, "onFileChange". */
  latexWorkshopAutoBuild: string | undefined;
  overtexBuildOnSave: boolean;
}

/** True when both extensions would run TeX on the same save. */
export function hasBuildConflict(inputs: ConflictInputs): boolean {
  if (!inputs.latexWorkshopInstalled || !inputs.overtexBuildOnSave) {
    return false;
  }
  return (inputs.latexWorkshopAutoBuild ?? 'onFileChange') !== 'never';
}
