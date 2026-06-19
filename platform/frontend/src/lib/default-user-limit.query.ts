import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const {
  listDefaultUserLimits,
  createDefaultUserLimit,
  updateDefaultUserLimit,
  deleteDefaultUserLimit,
} = archestraApiSdk;

export type DefaultUserLimit =
  archestraApiTypes.ListDefaultUserLimitsResponses["200"][number];

type UpdateDefaultUserLimitParams =
  archestraApiTypes.UpdateDefaultUserLimitData["path"] &
    archestraApiTypes.UpdateDefaultUserLimitData["body"];
type DeleteDefaultUserLimitParams =
  archestraApiTypes.DeleteDefaultUserLimitData["path"];

const QUERY_KEY = ["default-user-limits"] as const;

export function useDefaultUserLimits() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await listDefaultUserLimits();
      return response.data ?? [];
    },
  });
}

export function useCreateDefaultUserLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateDefaultUserLimitData["body"],
    ) => {
      const response = await createDefaultUserLimit({ body: data });
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Environment user limit created");
    },
    onError: (error) => {
      console.error("Create default user limit error:", error);
      toast.error("Failed to create environment user limit");
    },
  });
}

export function useUpdateDefaultUserLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: UpdateDefaultUserLimitParams) => {
      const response = await updateDefaultUserLimit({
        path: { id },
        body: data,
      });
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Environment user limit updated");
    },
    onError: (error) => {
      console.error("Update default user limit error:", error);
      toast.error("Failed to update environment user limit");
    },
  });
}

export function useDeleteDefaultUserLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: DeleteDefaultUserLimitParams) => {
      const response = await deleteDefaultUserLimit({ path: { id } });
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Environment user limit deleted");
    },
    onError: (error) => {
      console.error("Delete default user limit error:", error);
      toast.error("Failed to delete environment user limit");
    },
  });
}
