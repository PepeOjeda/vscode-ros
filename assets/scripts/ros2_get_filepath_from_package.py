import sys
import os
from ros2launch.api import get_share_file_path_from_package

def main(args):
    mode = 'single file'
        # Test if first argument is a file, and if not change to pkg
        # file mode.
    if not os.path.isfile(args[1]):
        mode = 'pkg file'
    
    if mode == 'single file':
        print(args[1],end="")
    else:
        print(get_share_file_path_from_package(
                        package_name=args[1],
                        file_name=args[2]),
        end="")
    
if __name__ == "__main__":
    main(sys.argv)