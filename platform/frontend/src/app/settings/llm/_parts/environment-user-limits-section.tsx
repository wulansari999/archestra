"use client";

import { Boxes, Edit, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import {
  CLEANUP_INTERVAL_LABELS,
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  type LimitCleanupInterval,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type DefaultUserLimit,
  useCreateDefaultUserLimit,
  useDefaultUserLimits,
  useDeleteDefaultUserLimit,
  useUpdateDefaultUserLimit,
} from "@/lib/default-user-limit.query";
import { useEnvironments } from "@/lib/environment.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";

type FormState = {
  environmentId: string;
  limitValue: string;
  models: string[];
  isAllModels: boolean;
  cleanupInterval: LimitCleanupInterval;
};

const EMPTY_FORM_STATE: FormState = {
  environmentId: "",
  limitValue: "",
  models: [],
  isAllModels: true,
  cleanupInterval: DEFAULT_LIMIT_CLEANUP_INTERVAL,
};

function formatCurrencyWhole(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumericInput(value: string) {
  if (!value) return "";
  return Number(value).toLocaleString("en-US");
}

export function EnvironmentUserLimitsSection() {
  const { data: environmentsData } = useEnvironments();
  const environments = environmentsData?.environments ?? [];
  const { data: limits = [] } = useDefaultUserLimits();
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const createLimit = useCreateDefaultUserLimit();
  const updateLimit = useUpdateDefaultUserLimit();
  const deleteLimit = useDeleteDefaultUserLimit();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DefaultUserLimit | null>(null);
  const [formState, setFormState] = useState<FormState>(EMPTY_FORM_STATE);
  const [toDelete, setToDelete] = useState<DefaultUserLimit | null>(null);

  const modelOptions = modelsWithApiKeys.map((model) => ({
    value: model.modelId,
    model: model.modelId,
    provider: model.provider,
    pricePerMillionInput: model.pricePerMillionInput ?? "0",
    pricePerMillionOutput: model.pricePerMillionOutput ?? "0",
    isFree: model.isFree,
    isBest: model.isBest,
  }));

  const environmentName = (id: string) =>
    environments.find((environment) => environment.id === id)?.name ??
    "Unknown environment";

  // Environments that don't yet have a limit (creation only — one per env).
  const availableEnvironments = environments.filter(
    (environment) =>
      !limits.some((limit) => limit.environmentId === environment.id),
  );

  const handleAddOpen = () => {
    setEditing(null);
    setFormState(EMPTY_FORM_STATE);
    setIsDialogOpen(true);
  };

  const handleEditOpen = (limit: DefaultUserLimit) => {
    setEditing(limit);
    const models = Array.isArray(limit.model) ? limit.model : [];
    setFormState({
      environmentId: limit.environmentId,
      limitValue: String(limit.limitValue),
      models,
      isAllModels: models.length === 0,
      cleanupInterval: limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
    });
    setIsDialogOpen(true);
  };

  const canSubmit =
    Number(formState.limitValue) > 0 &&
    (formState.isAllModels || formState.models.length > 0) &&
    formState.environmentId.length > 0;

  async function handleSubmit() {
    const model = formState.isAllModels ? null : formState.models;
    const limitValue = Number(formState.limitValue);

    if (editing) {
      const result = await updateLimit.mutateAsync({
        id: editing.id,
        limitValue,
        model,
        cleanupInterval: formState.cleanupInterval,
      });
      if (result) {
        setIsDialogOpen(false);
        setEditing(null);
      }
      return;
    }

    const result = await createLimit.mutateAsync({
      environmentId: formState.environmentId,
      limitValue,
      model,
      cleanupInterval: formState.cleanupInterval,
    });
    if (result) {
      setIsDialogOpen(false);
    }
  }

  async function handleDelete() {
    if (!toDelete) return;
    await deleteLimit.mutateAsync({ id: toDelete.id });
    setToDelete(null);
  }

  return (
    <SettingsBlock
      title="Per-environment user limits"
      description="Override the default user limit per environment — for example, a smaller cap in production than in development. A per-environment limit applies to every user's usage within that environment and takes precedence over the org-wide default above. A custom per-user limit still overrides both."
      control={
        <PermissionButton
          permissions={{ llmLimit: ["create"] }}
          onClick={handleAddOpen}
          disabled={availableEnvironments.length === 0 && !editing}
        >
          <Plus className="h-4 w-4" />
          Add limit
        </PermissionButton>
      }
    >
      {environments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No environments configured. Create an environment to set
          per-environment user limits.
        </p>
      ) : limits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No per-environment user limits configured.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Models</TableHead>
              <TableHead>Limit value</TableHead>
              <TableHead>Cleanup interval</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {limits.map((limit) => {
              const models = Array.isArray(limit.model) ? limit.model : [];
              return (
                <TableRow key={limit.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {environmentName(limit.environmentId)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {models.length === 0 ? "All models" : models.join(", ")}
                  </TableCell>
                  <TableCell>{formatCurrencyWhole(limit.limitValue)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {CLEANUP_INTERVAL_LABELS[
                      limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL
                    ] ?? limit.cleanupInterval}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <WithPermissions
                        permissions={{ llmLimit: ["update"] }}
                        noPermissionHandle="hide"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditOpen(limit)}
                          aria-label="Edit limit"
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </WithPermissions>
                      <WithPermissions
                        permissions={{ llmLimit: ["delete"] }}
                        noPermissionHandle="hide"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setToDelete(limit)}
                          aria-label="Delete limit"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </WithPermissions>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <FormDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={
          editing ? "Edit environment user limit" : "Add environment user limit"
        }
        description="Set a per-user token-cost cap for usage within an environment."
        size="small"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label>Environment</Label>
              {editing ? (
                <Input
                  value={environmentName(formState.environmentId)}
                  disabled
                />
              ) : (
                <SearchableSelect
                  value={formState.environmentId}
                  onValueChange={(value) =>
                    setFormState((current) => ({
                      ...current,
                      environmentId: value,
                    }))
                  }
                  placeholder="Select environment"
                  items={availableEnvironments.map((environment) => ({
                    value: environment.id,
                    label: environment.name,
                    description: environment.description ?? undefined,
                  }))}
                />
              )}
            </div>

            <div className="space-y-2">
              <Label>Models</Label>
              <LlmModelPicker
                multiple
                sortDirection="desc"
                value={formState.isAllModels ? ["all"] : formState.models}
                onValueChange={(values) => {
                  const isAllModels = values.includes("all");
                  setFormState((current) => ({
                    ...current,
                    isAllModels,
                    models: isAllModels ? [] : values,
                  }));
                }}
                models={modelOptions}
                includeAllOption
              />
            </div>

            <div className="space-y-2">
              <Label>Limit value ($)</Label>
              <Input
                value={formatNumericInput(formState.limitValue)}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    limitValue: event.target.value.replace(/[^0-9]/g, ""),
                  }))
                }
                placeholder="1,000"
                inputMode="numeric"
              />
            </div>

            <div className="space-y-2">
              <Label>Cleanup interval</Label>
              <LimitCleanupIntervalSelect
                value={formState.cleanupInterval}
                onValueChange={(value) =>
                  setFormState((current) => ({
                    ...current,
                    cleanupInterval: value,
                  }))
                }
              />
            </div>
          </DialogBody>

          <DialogStickyFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !canSubmit || createLimit.isPending || updateLimit.isPending
              }
            >
              {editing ? "Save" : "Add"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!toDelete}
        onOpenChange={(open) => !open && setToDelete(null)}
        title="Delete environment user limit"
        description={
          toDelete
            ? `Remove the per-user limit for ${environmentName(toDelete.environmentId)}? Usage in this environment will fall back to the org-wide default.`
            : ""
        }
        isPending={deleteLimit.isPending}
        onConfirm={handleDelete}
      />
    </SettingsBlock>
  );
}
