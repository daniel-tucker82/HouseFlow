import java.nio.file.Path;
import maestro.orchestra.yaml.YamlCommandReader;
import maestro.utils.FileAccessScope;

/** Parse flows and their referenced subflows with the same pinned runner as CI. */
class CheckMaestroFlows {
    public static void main(String[] args) {
        if (args.length < 2) {
            throw new IllegalArgumentException("Pass the mobile workspace and at least one flow.");
        }
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        FileAccessScope scope = FileAccessScope.Companion.under(root);
        for (int i = 1; i < args.length; i++) {
            Path flow = root.resolve(args[i]).normalize();
            if (!flow.startsWith(root)) {
                throw new IllegalArgumentException("Flow must be inside the mobile workspace.");
            }
            YamlCommandReader.INSTANCE.readCommands(flow, scope);
            System.out.println("Parsed " + root.relativize(flow));
        }
    }
}
