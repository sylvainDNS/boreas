import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

const healthSchema = z.object({
  status: z.string(),
  refreshIntervalMin: z.number(),
  purgeWindowDays: z.number(),
  theme: z.string(),
});

type HealthResponse = z.infer<typeof healthSchema>;

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`/api/health a répondu ${res.status}`);
  return healthSchema.parse(await res.json());
}

export default function App() {
  const { data, isLoading, error } = useQuery<HealthResponse, Error>({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });

  if (isLoading) return <p>Chargement…</p>;
  if (error) return <p>Erreur : {error.message}</p>;
  if (!data) return null;

  return (
    <main>
      <h1>Boréas</h1>
      <dl>
        <dt>Statut API</dt>
        <dd>{data.status}</dd>
        <dt>Rafraîchissement</dt>
        <dd>{data.refreshIntervalMin} min</dd>
        <dt>Rétention</dt>
        <dd>{data.purgeWindowDays} jours</dd>
        <dt>Thème</dt>
        <dd>{data.theme}</dd>
      </dl>
    </main>
  );
}
